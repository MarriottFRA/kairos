# Porting TPM device binding to another Electron app

Guide for reusing the hardware-sealed device key from this repo in a sibling
Electron project. Read alongside the actual files — this document explains the
seams, the files are the implementation.

Source of truth for the protocol: the backend's `DEVICE_REGISTRATION_CLIENT_GUIDE.md`
and `SECURITY_LEVELS.md`.

---

## The one-paragraph version

Each device creates one P-256 key inside its TPM, once. The private half never
leaves the chip. The server stores the public half. From then on, proving "this
is the real machine" means the server issues a one-time nonce and the device
signs it — something only that physical machine can do. The existing
`device_secret` stays on as a second check and as the fallback for machines
with no TPM.

**Core rule: a device is TPM-bound ⟺ the server holds a public key for it.**
The server decides whether a signature is required; the client can never opt
out, and must never hard-fail because a TPM step failed.

---

## Files, by how portable they are

### Drop-in — copy verbatim, no edits

| File | Depends on |
|---|---|
| `src/main/system/tpm.ts` | `node:crypto`, lazy `require("koffi")` |
| `src/main/auth/deviceProgress.ts` | nothing |

`tpm.ts` is the only native code: NCrypt/CNG bindings for create-key,
export-public-key, sign, delete-key, plus availability probes. Every failure
mode (no TPM, TPM disabled, VM, non-Windows, koffi missing) surfaces as a single
`TpmUnavailableError`, so callers catch one thing.

`deviceProgress.ts` is the step vocabulary + a `sendToRenderer`-bound emitter.
Only needed if you also want the real progress bars.

### Near drop-in — one adapter

`src/main/auth/tpmBinding.ts` — all the policy: the nonce dance, the local
attempt record, and binding an already-registered device.

It reaches outside itself in exactly two places:

1. `import { net } from "electron"` — used for `/devices/challenge` (needs no
   auth) and `/devices/tpm/register` (needs only a bearer). This is deliberate:
   depending on an ApiClient would create an
   `ApiClient → SessionManager → TpmBinding` construction cycle. **Keep it.**
2. `import * as db from "../../local_db"` — only `getUserSettings(key)` and
   `setUserSettings({key: value})`. If the target project has a different
   key-value store, change the two calls in `getState()` / `setState()`.

   Note the contract this repo's `getUserSettings` has: it returns the **parsed**
   value, or the literal string `"null"` when absent. If your store returns raw
   JSON or `undefined`, adjust the guard in `getState()` accordingly.

### Integration — rewrite against the target's auth stack

These are diffs, not files to copy. See "Integration checklist" below.

- `src/main/auth/authController.ts` — signed verify, post-verify bind, inline
  enrollment on register
- `src/main/auth/sessionManager.ts` — signed refresh
- `src/main/auth/index.ts` — construction wiring
- `src/preload.ts`, `src/services/auth.ts` — the progress bridge
- `src/routes/device-verify.tsx`, `src/styles/auth.css` — the UI
- `forge.config.ts` — packaging

**If the target project was forked from this one**, the diffs apply almost
verbatim. **If not**, treat them as a specification of where the four call sites
go, and write them against whatever that project's auth layer looks like.

---

## Integration checklist

### 1. Dependency

```
npm install koffi
```

koffi is Node-API based, so **no** Electron rebuild is needed.

### 2. Packaging — the trap that costs the most time

`koffi` is only a JS shim. The actual `koffi.node` binary lives in a **separate
optional package**, `@koromix/koffi-win32-x64`. If your packaging step uses an
explicit allowlist of modules to copy (as this repo's `forge.config.ts`
`postPackage` hook does), **both** must be listed:

```ts
'koffi',
'@koromix/koffi-win32-x64',
```

Ship only the first and you get a build that looks fine and silently reports
"no TPM" on every installed machine, while dev works perfectly. Verify after
packaging:

```
<out>/resources/app/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node
```

If the target bundles with Vite/Rollup, also make sure `koffi` is **external**
(not bundled) so the emitted code is `require("koffi")`.

### 3. The four call sites

**a. Register a new device — bind inline.** Spread the enrollment pair into the
`/devices/register` body. Both fields or neither; the backend 422s on half a pair:

```ts
const enrollment = await tpmBinding.enrollmentPayload(deviceId);
// ...
body: JSON.stringify({ ...existingFields, ...(enrollment ?? {}) })
```

**Critical:** a `400`/`401` response when a `public_key` was sent means the
device **is registered, just unbound** — it is *not* a registration failure.
Classify the binding outcome, then re-POST **without** the TPM fields
(registration is idempotent for the same secret) so the user still reaches the
normal pending screen. `403` means "already approved, use endpoint 3" — also
retry without, and let the post-verify bind step handle it. `409` means already
bound, which is the desired end state.

**b. Verify — sign the nonce.** Add `signature` to the `/devices/verify` body
when defined. Returns `undefined` on any device that never enrolled, so the
field is simply omitted.

**c. Verify — bind afterwards.** `/devices/tpm/register` needs a tier-2 token
bound to *this* device when the device is approved, so binding an existing
device can only happen **after** a successful verify. Gate it on
`tpmBinding.shouldAttempt()` so it costs nothing on machines already known to
be unbindable.

**d. Refresh — sign the nonce.** Same shape as verify, purpose `"refresh"`.

### 4. The 401 handling — do not skip this

This is where a naive port breaks working installs.

Nonces are single-use and **burn on failed attempts too**, and they expire in
120s. So a 401 on a *signed* call is ambiguous: it may just be a stale or
already-consumed nonce.

Most existing auth stacks treat 401 as terminal — "re-register this device" on
verify, "kill the session" on refresh. Both become wrong once signatures are in
play. Before acting on a 401, **request a fresh challenge, re-sign, and retry
exactly once.**

Two further subtleties worth copying:

- On verify, retry with a signature **even if the first attempt had none**. That
  recovers the case where the local settings DB was wiped but the sealed key
  survived. `signNonce(id, purpose, { force: true })` does this.
- When deciding "the server holds a key we can no longer satisfy", key the
  decision off the **first** attempt's signature, not the forced retry. The
  forced retry is speculative; its failure proves nothing about binding.
  Getting this backwards strands a device whose secret merely changed behind a
  dead-end "contact your administrator" screen instead of auto re-registering.

### 5. Retry policy — the "don't waste time" requirement

Stored in the settings store under `tpmBinding`:

```json
{ "status": "unknown|unsupported|bound|failed",
  "attempts": 0, "lastAttemptAt": "<iso>", "lastError": "<string>" }
```

- **Hardware failure** (no TPM, disabled, VM, NCrypt error) → `unsupported`,
  **permanent**, never retried. Detected with **zero** network calls, because
  the TPM is touched before any challenge is requested.
- **Signature rejected by the server** (401) → `failed`, permanent. Retrying
  cannot help.
- **Transient** (offline, 5xx, 429, stale nonce) → stays `unknown`, `attempts`
  increments; latches to `failed` at 3.

Do **not** collapse these into a single "tried and failed, never again" flag —
one transient outage would then permanently disable TPM for that install.

### 6. Rate limiting

`/devices/challenge` returns **429** if called twice for the same
`device_id`+`purpose` within 5s. Back off once and give up. **Never loop.**

### 7. No recovery UI for a cleared TPM

There is deliberately no unbind endpoint. If a bound device stops
authenticating, the path is `DELETE /devices/{id}` → re-register → wait for
admin approval again. Surface a distinct sentinel (this repo uses
`DEVICE_TPM_MISMATCH`) and show an admin-contact message — do **not** loop
through registration, which cannot fix it.

A motherboard swap or reimage already changes `device_secret`, so those cases
behave exactly as they did before this feature.

---

## Progress bars (optional)

Only worth porting if the target has the same fake-timer progress UI. The shape:
main emits one event per step transition on `auth:device-progress`; the renderer
holds a `Record<stepId, state>` and derives the bar width from how many steps
have settled. No timers anywhere.

`skipped` is a **normal** outcome, not an error — render it dimmed
("Not available"), not red. A failed *optional* binding step is amber, not red:
the user is still signed in.

---

## Verifying the port

Do these in order. The first is non-negotiable — if it fails, nothing
downstream can work.

1. **Round-trip.** Create the key, export SPKI, sign a random payload, verify:

   ```js
   crypto.verify('sha256', payload, spkiKey, sig, { dsaEncoding: 'ieee-p1363' })
   ```

   Expected on real hardware: `ECCPUBLICBLOB` is **72 bytes** (magic
   `0x31534345`, `cbKey` 32, then X||Y), the derived SPKI DER is **91 bytes**,
   and the signature is **64 bytes** r||s. The backend accepts both r||s and DER.

2. **New device** — clear the stored `deviceId` and delete the
   `Kairos-Device-*` key. Register should bind inline; confirm `tpm_enrolled`
   server-side and `status === "bound"` locally.

3. **Existing approved device** — with no `tpmBinding` record, the bind runs
   after verify. Second login must make **no** `/devices/tpm/register` call.

4. **No TPM** — in a VM, or force `isAvailable()` false. Login must still
   succeed on `device_secret` alone, and a restart must attempt **no** challenge.

5. **Transient failure** — stub a 500 on the challenge. Login still succeeds,
   `attempts` increments, and it stops after 3.

6. **Burned nonce** — sign a stale nonce once. Verify must recover via the
   fresh-challenge retry rather than re-registering, and refresh must not log
   the user out.

7. **Packaged build** — see §2. The most likely place this silently regresses.

---

*This document is a porting aid, not part of the app. Delete it if it is not
useful to keep in-tree.*
