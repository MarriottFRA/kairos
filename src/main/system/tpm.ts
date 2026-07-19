/**
 * TPM — a hardware-sealed P-256 signing key, via Windows CNG (ncrypt.dll).
 * -----------------------------------------------------------
 * One key per device, created once inside the "Microsoft Platform Crypto
 * Provider" (the TPM). The private half never leaves the chip: we can export
 * only the public half, and we can ask the chip to sign a digest. That is the
 * whole capability, and it is enough — the server hands out a one-time nonce
 * and only this physical machine can produce a valid signature over it.
 *
 * EVERYTHING HERE IS BEST-EFFORT. No TPM, TPM disabled in firmware, a VM, a
 * non-Windows build, koffi failing to load — all surface as TpmUnavailableError
 * so the caller has exactly one thing to catch and can fall back to
 * device_secret-only auth. Nothing in this module may crash the main process.
 *
 * Verified against real hardware: ECCPUBLICBLOB is 72 bytes (magic 0x31534345,
 * cbKey 32, then X||Y), the derived SPKI DER is 91 bytes, and NCryptSignHash
 * returns a 64-byte r||s signature that verifies with Node's
 * `dsaEncoding: 'ieee-p1363'`.
 */

import crypto from "crypto";

/** Thrown for every failure mode — "this machine cannot do TPM signing". */
export class TpmUnavailableError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "TpmUnavailableError";
  }
}

/** The TPM-backed CNG provider. Software providers are deliberately NOT used —
 *  a software key would defeat the entire point of hardware binding. */
const PROVIDER = "Microsoft Platform Crypto Provider";

/** NCRYPT_ECDSA_P256_ALGORITHM / BCRYPT_ECCPUBLIC_BLOB. */
const ALGORITHM = "ECDSA_P256";
const PUBLIC_BLOB_TYPE = "ECCPUBLICBLOB";

/** BCRYPT_ECDSA_PUBLIC_P256_MAGIC — guards against a provider handing back a
 *  blob for a different curve than the one we asked for. */
const ECDSA_PUBLIC_P256_MAGIC = 0x31534345;

/** NCRYPT_*_HANDLE is a ULONG_PTR. */
const HANDLE = "uintptr_t";

/** A handle value of 0 is NULL — NCryptExportKey's optional hExportKey. */
const NULL_HANDLE = 0;

interface NCryptBindings {
  openStorageProvider: (out: number[], name: string, flags: number) => number;
  openKey: (
    prov: number,
    out: number[],
    name: string,
    keySpec: number,
    flags: number
  ) => number;
  createPersistedKey: (
    prov: number,
    out: number[],
    algId: string,
    name: string,
    keySpec: number,
    flags: number
  ) => number;
  finalizeKey: (key: number, flags: number) => number;
  exportKey: (
    key: number,
    exportKey: number,
    blobType: string,
    params: null,
    output: Buffer,
    outputLen: number,
    result: number[],
    flags: number
  ) => number;
  signHash: (
    key: number,
    padding: null,
    hash: Buffer,
    hashLen: number,
    signature: Buffer,
    signatureLen: number,
    result: number[],
    flags: number
  ) => number;
  deleteKey: (key: number, flags: number) => number;
  freeObject: (handle: number) => number;
}

/**
 * Lazily loaded bindings. `null` = not attempted yet, `false` = attempted and
 * unavailable (cached so we don't retry a doomed dlopen on every call).
 */
let bindings: NCryptBindings | null | false = null;

function loadBindings(): NCryptBindings {
  if (bindings === false) {
    throw new TpmUnavailableError("ncrypt.dll is not available on this platform");
  }
  if (bindings) {
    return bindings;
  }

  try {
    if (process.platform !== "win32") {
      throw new Error(`CNG is Windows-only (platform: ${process.platform})`);
    }
    // Required lazily so a missing/broken koffi never breaks main-process boot.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require("koffi");
    const lib = koffi.load("ncrypt.dll");

    bindings = {
      openStorageProvider: lib.func(
        `int32 NCryptOpenStorageProvider(_Out_ ${HANDLE} *phProvider, str16 pszProviderName, uint32 dwFlags)`
      ),
      openKey: lib.func(
        `int32 NCryptOpenKey(${HANDLE} hProvider, _Out_ ${HANDLE} *phKey, str16 pszKeyName, uint32 dwLegacyKeySpec, uint32 dwFlags)`
      ),
      createPersistedKey: lib.func(
        `int32 NCryptCreatePersistedKey(${HANDLE} hProvider, _Out_ ${HANDLE} *phKey, str16 pszAlgId, str16 pszKeyName, uint32 dwLegacyKeySpec, uint32 dwFlags)`
      ),
      finalizeKey: lib.func(`int32 NCryptFinalizeKey(${HANDLE} hKey, uint32 dwFlags)`),
      exportKey: lib.func(
        `int32 NCryptExportKey(${HANDLE} hKey, ${HANDLE} hExportKey, str16 pszBlobType, void *pParameterList, _Out_ uint8_t *pbOutput, uint32 cbOutput, _Out_ uint32 *pcbResult, uint32 dwFlags)`
      ),
      signHash: lib.func(
        `int32 NCryptSignHash(${HANDLE} hKey, void *pPaddingInfo, uint8_t *pbHashValue, uint32 cbHashValue, _Out_ uint8_t *pbSignature, uint32 cbSignature, _Out_ uint32 *pcbResult, uint32 dwFlags)`
      ),
      deleteKey: lib.func(`int32 NCryptDeleteKey(${HANDLE} hKey, uint32 dwFlags)`),
      freeObject: lib.func(`int32 NCryptFreeObject(${HANDLE} hObject)`),
    };
    return bindings;
  } catch (error) {
    bindings = false;
    throw new TpmUnavailableError(
      `Failed to load ncrypt.dll bindings: ${(error as Error).message}`
    );
  }
}

/** SECURITY_STATUS is a LONG; 0 is ERROR_SUCCESS, anything else is an NTSTATUS-shaped code. */
function check(operation: string, status: number): void {
  if (status !== 0) {
    throw new TpmUnavailableError(
      `${operation} failed (0x${(status >>> 0).toString(16)})`,
      status
    );
  }
}

/**
 * The per-device key name. Derived from device_id so a device that is deleted
 * server-side and re-registered reuses the same sealed key (device_id is stable
 * in user_settings), while two installs never collide.
 */
export function keyNameFor(deviceId: string): string {
  // CNG key names are free-form, but keep it to a safe character set.
  return `Kairos-Device-${deviceId.replace(/[^A-Za-z0-9-]/g, "")}`;
}

/**
 * Run `fn` with an open provider handle, always freeing it. Every entry point
 * goes through here so a handle can never leak on an error path.
 */
function withProvider<T>(fn: (prov: number, api: NCryptBindings) => T): T {
  const api = loadBindings();
  const out = [0];
  check("NCryptOpenStorageProvider", api.openStorageProvider(out, PROVIDER, 0));
  const prov = out[0];
  try {
    return fn(prov, api);
  } finally {
    try {
      api.freeObject(prov);
    } catch {
      /* nothing useful to do */
    }
  }
}

/** Open an existing key, or create + finalize a new persisted one. */
function withKey<T>(
  deviceId: string,
  create: boolean,
  fn: (key: number, api: NCryptBindings) => T
): T {
  return withProvider((prov, api) => {
    const name = keyNameFor(deviceId);
    const out = [0];
    let status = api.openKey(prov, out, name, 0, 0);

    if (status !== 0) {
      if (!create) {
        check("NCryptOpenKey", status);
      }
      // NTE_BAD_KEYSET (0x80090016) on a machine with a TPM simply means "no key
      // yet". Any other code (no TPM, provider unusable) will fail here too.
      status = api.createPersistedKey(prov, out, ALGORITHM, name, 0, 0);
      check("NCryptCreatePersistedKey", status);
      check("NCryptFinalizeKey", api.finalizeKey(out[0], 0));
    }

    const key = out[0];
    try {
      return fn(key, api);
    } finally {
      try {
        api.freeObject(key);
      } catch {
        /* nothing useful to do */
      }
    }
  });
}

/**
 * True when the TPM provider can be opened at all. Cheap probe used to decide
 * whether enrollment is even worth attempting.
 */
export function isAvailable(): boolean {
  try {
    withProvider(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** True when a sealed key already exists for this device. Never throws. */
export function hasKey(deviceId: string): boolean {
  try {
    withKey(deviceId, false, () => undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the sealed key if it does not exist yet. Throws TpmUnavailableError on
 * any machine that cannot do this.
 */
export function createKey(deviceId: string): void {
  withKey(deviceId, true, () => undefined);
}

/**
 * Export the public half as a DER SubjectPublicKeyInfo — the format the backend
 * (Python `cryptography`) expects.
 *
 * CNG gives us BCRYPT_ECCPUBLIC_BLOB: { ULONG Magic; ULONG cbKey } then the raw
 * affine X and Y coordinates. Rather than hand-rolling ASN.1 we hand the
 * coordinates to Node as a JWK and let it emit the SPKI.
 */
export function exportPublicKeyDer(deviceId: string): Buffer {
  return withKey(deviceId, true, (key, api) => {
    // A P-256 public blob is 8 + 32 + 32 = 72 bytes; 256 is ample headroom.
    const blob = Buffer.alloc(256);
    const written = [0];
    check(
      "NCryptExportKey",
      api.exportKey(
        key,
        NULL_HANDLE,
        PUBLIC_BLOB_TYPE,
        null,
        blob,
        blob.length,
        written,
        0
      )
    );

    if (written[0] < 8) {
      throw new TpmUnavailableError("ECCPUBLICBLOB too short");
    }
    const magic = blob.readUInt32LE(0);
    const cbKey = blob.readUInt32LE(4);
    if (magic !== ECDSA_PUBLIC_P256_MAGIC || cbKey !== 32) {
      throw new TpmUnavailableError(
        `Unexpected ECC blob (magic 0x${magic.toString(16)}, cbKey ${cbKey})`
      );
    }

    const x = blob.subarray(8, 8 + cbKey);
    const y = blob.subarray(8 + cbKey, 8 + cbKey * 2);

    const publicKey = crypto.createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: x.toString("base64url"),
        y: y.toString("base64url"),
      },
      format: "jwk",
    });

    return Buffer.from(publicKey.export({ type: "spki", format: "der" }));
  });
}

/**
 * Sign `payload` with the sealed key: SHA-256 the payload here, then have the
 * chip sign the digest (NCryptSignHash takes a digest, not a message).
 *
 * Returns the raw 64-byte r||s that CNG produces. The backend accepts both this
 * and DER, so we send it as-is rather than converting.
 */
export function sign(deviceId: string, payload: Buffer): Buffer {
  return withKey(deviceId, false, (key, api) => {
    const digest = crypto.createHash("sha256").update(payload).digest();
    // P-256 r||s is 64 bytes; allow headroom in case a provider returns DER.
    const signature = Buffer.alloc(256);
    const written = [0];
    check(
      "NCryptSignHash",
      api.signHash(
        key,
        null,
        digest,
        digest.length,
        signature,
        signature.length,
        written,
        0
      )
    );
    if (written[0] === 0) {
      throw new TpmUnavailableError("NCryptSignHash produced an empty signature");
    }
    return Buffer.from(signature.subarray(0, written[0]));
  });
}

/**
 * Delete the sealed key. Not used by the auth flow — there is deliberately no
 * unbind path — but needed to reset a machine during testing.
 */
export function deleteKey(deviceId: string): void {
  withProvider((prov, api) => {
    const out = [0];
    check("NCryptOpenKey", api.openKey(prov, out, keyNameFor(deviceId), 0, 0));
    check("NCryptDeleteKey", api.deleteKey(out[0], 0));
  });
}
