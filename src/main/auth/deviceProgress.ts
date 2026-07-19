/**
 * DeviceProgress — real, main-driven progress for the device security screen.
 * -----------------------------------------------------------
 * The renderer used to fake both progress bars with a setInterval that had no
 * relationship to the work being done. Now main emits a event per step
 * transition and the renderer derives the bar from those, so what the user sees
 * is what actually happened — including the TPM steps, which are the whole
 * reason the bar needed to be real.
 *
 * The renderer owns the label text; main only names steps and their state.
 */

/** Push channel (main -> renderer). Bridged in preload as onDeviceProgress. */
export const DEVICE_PROGRESS_CHANNEL = "auth:device-progress";

/** Which of the two flows the screen is currently running. */
export type DeviceProgressPhase = "verify" | "register";

/**
 * Steps, in display order. Each phase has five so the two bars stay visually
 * symmetric. `sign` appears in both — it is the TPM signing/enrollment notch.
 */
export const VERIFY_STEPS = [
  "identify", // derive device_id + device_secret
  "sign", // sign a verify nonce with the sealed key (or skip: no TPM)
  "validate", // POST /devices/verify
  "bind", // adopt a sealed key if this device has never bound one
  "secure", // session established
] as const;

export const REGISTER_STEPS = [
  "identify", // derive device_id + device_secret
  "profile", // gather the hardware fingerprint
  "sign", // create the sealed key + sign an enroll nonce (or skip: no TPM)
  "submit", // POST /devices/register
  "check", // follow-up verify to see if it was auto-approved
] as const;

export type VerifyStep = (typeof VERIFY_STEPS)[number];
export type RegisterStep = (typeof REGISTER_STEPS)[number];
export type DeviceProgressStep = VerifyStep | RegisterStep;

/**
 * `skipped` is a first-class outcome, not a failure: a machine with no TPM
 * legitimately skips the hardware steps and must not look broken.
 */
export type DeviceProgressState = "active" | "done" | "skipped" | "failed";

export interface DeviceProgressEvent {
  phase: DeviceProgressPhase;
  step: DeviceProgressStep;
  state: DeviceProgressState;
  /** Short human-readable note shown under the step (e.g. "Not available"). */
  detail?: string;
}

export type EmitDeviceProgress = (
  phase: DeviceProgressPhase,
  step: DeviceProgressStep,
  state: DeviceProgressState,
  detail?: string
) => void;

/**
 * Build an emitter bound to the renderer channel. Emission is best-effort: a
 * closed window must never break the auth flow that is reporting into it.
 */
export function createProgressEmitter(
  sendToRenderer: (channel: string, payload?: unknown) => void
): EmitDeviceProgress {
  return (phase, step, state, detail) => {
    try {
      sendToRenderer(DEVICE_PROGRESS_CHANNEL, {
        phase,
        step,
        state,
        detail,
      } as DeviceProgressEvent);
    } catch {
      /* progress reporting is never load-bearing */
    }
  };
}
