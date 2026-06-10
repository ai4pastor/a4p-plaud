import { PlaudTokenData } from "./types";

export type PlaudAuthErrorCode =
  | "OAUTH_FAILED"
  | "REFRESH_FAILED"
  | "CANCELLED"
  | "STATE_MISMATCH"
  | "UNKNOWN";

export class PlaudAuthError extends Error {
  constructor(public code: PlaudAuthErrorCode, message: string) {
    super(message);
    this.name = "PlaudAuthError";
  }
}

export function isTokenExpired(token: PlaudTokenData): boolean {
  return Date.now() >= token.expiresAt;
}

/** access token은 보통 단명 — 만료 5분 전이면 미리 refresh한다. */
const DEFAULT_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export function isTokenNearExpiry(
  token: PlaudTokenData,
  bufferMs: number = DEFAULT_EXPIRY_BUFFER_MS
): boolean {
  return Date.now() >= token.expiresAt - bufferMs;
}
