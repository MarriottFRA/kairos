/**
 * useAuthStatus — subscribe a component to the auth client's status + resume
 * state so it re-renders when the background cold-start resume resolves (drives
 * the login page's "Continue session" affordance).
 */

import { useEffect, useReducer } from "react";
import authService, { PublicAuthStatus } from "../services/auth";

export interface AuthStatusView {
  status: PublicAuthStatus;
  resolving: boolean; // background resume still checking the token
  resumable: boolean; // a token worth resuming exists (local pre-check passed)
}

export function useAuthStatus(): AuthStatusView {
  const [, force] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    // subscribe returns an unsubscribe fn — perfect as the effect cleanup.
    return authService.subscribe(force);
  }, []);

  return {
    status: authService.getStatusSnapshot(),
    resolving: authService.isResolving(),
    resumable: authService.hasResumableSession(),
  };
}
