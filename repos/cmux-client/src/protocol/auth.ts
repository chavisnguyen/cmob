/**
 * cmux-mobile Authentication Protocol Types & Constants
 * Modeled after cmux-pocket Gateway Protocol v2 (ref/cmux-pocket/crates/cmux-pocket-protocol/src/auth.rs)
 */

export const PROTOCOL_SERVER_VERSION = "2.0.0";
export const WS_CLOSE_AUTH_FAILED = 1008;

export const AUTH_REASON_INVALID_TOKEN = "invalid_token";
export const AUTH_REASON_UNAUTHENTICATED = "unauthenticated";

export const CAPABILITIES = {
  RENDER_GRID: "terminal.render_grid.v1",
  INPUT_ORDERED: "terminal.input.ordered.v1",
  WORKSPACE_CHANGES: "workspace.changes.v1",
  EVENTS: "events.v1",
  CLIENT_FOCUS: "client_focus.v1",
  MULTI_SURFACE: "multi_surface.v1",
  HOST_WAKE: "mobile.host.wake_cmux.v1",
  TERMINAL_VIEWPORT: "terminal.viewport.v1",
  AGENT_CHAT: "agent.chat.v1",
  PUSH_REGISTRATION: "push.registration.v1",
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

export interface AuthRequest {
  type: "auth";
  token: string;
  client_id?: string;
  [key: string]: unknown;
}

export interface AuthOk {
  type: "auth_ok";
  session_id: string;
  server_version: string;
  capabilities: string[];
  [key: string]: unknown;
}

export interface AuthError {
  type: "auth_error";
  reason: string;
  [key: string]: unknown;
}

export type AuthResponse = AuthOk | AuthError;

export function createAuthRequest(token: string, clientId = "cmux-client"): AuthRequest {
  return {
    type: "auth",
    token,
    client_id: clientId,
  };
}
