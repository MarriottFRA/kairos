/**
 * Authentication IPC Handlers
 * -----------------------------------------------------------
 * Thin adapters over the main-process AuthController. Each channel is an
 * explicit, named domain action — the renderer never gets a token or a generic
 * API passthrough. Handlers return plain data; the registry wraps it in the
 * standard { success, data, timestamp } envelope and converts thrown errors to
 * { success: false, error }.
 */

import { IpcHandler } from "../types";
import { AuthController } from "../../main/auth/authController";

/** Auth IPC channel names (also mirrored in the preload allowlist). */
export const AUTH_CHANNELS = {
  BEGIN_MS_SIGN_IN: "auth:beginMicrosoftSignIn",
  MS_SIGN_OUT: "auth:microsoftSignOut",
  REGISTER: "auth:register",
  LOGIN: "auth:login",
  REGISTER_DEVICE: "auth:registerDevice",
  VERIFY_DEVICE: "auth:verifyDevice",
  LOGOUT: "auth:logout",
  GET_STATUS: "auth:getStatus",
  RESUME: "auth:resume",
  HAS_RESUMABLE: "auth:hasResumableSession",
} as const;

export function createAuthHandlers(
  controller: AuthController
): Record<string, IpcHandler> {
  const beginMicrosoftSignIn: IpcHandler<{ silent?: boolean } | undefined> = (
    _event,
    p
  ) => controller.beginMicrosoftSignIn({ silent: p?.silent });

  const microsoftSignOut: IpcHandler = () => controller.microsoftSignOut();

  const register: IpcHandler<{ email: string }> = (_event, p) =>
    controller.register(p.email);

  const login: IpcHandler<{ email: string }> = (_event, p) =>
    controller.login(p.email);

  const registerDevice: IpcHandler = () => controller.registerDevice();

  // `phase: "register"` marks the follow-up approval check after a registration,
  // so it reports into the register progress bar instead of restarting the
  // verify one.
  const verifyDevice: IpcHandler<{ phase?: "verify" | "register" } | undefined> = (
    _event,
    p
  ) => controller.verifyDevice({ phase: p?.phase });

  const logout: IpcHandler = () => controller.logout();

  const getStatus: IpcHandler = () => controller.getStatus();

  const resume: IpcHandler = () => controller.resume();

  const hasResumableSession: IpcHandler = () => controller.hasResumableSession();

  return {
    [AUTH_CHANNELS.BEGIN_MS_SIGN_IN]: beginMicrosoftSignIn,
    [AUTH_CHANNELS.MS_SIGN_OUT]: microsoftSignOut,
    [AUTH_CHANNELS.REGISTER]: register,
    [AUTH_CHANNELS.LOGIN]: login,
    [AUTH_CHANNELS.REGISTER_DEVICE]: registerDevice,
    [AUTH_CHANNELS.VERIFY_DEVICE]: verifyDevice,
    [AUTH_CHANNELS.LOGOUT]: logout,
    [AUTH_CHANNELS.GET_STATUS]: getStatus,
    [AUTH_CHANNELS.RESUME]: resume,
    [AUTH_CHANNELS.HAS_RESUMABLE]: hasResumableSession,
  };
}
