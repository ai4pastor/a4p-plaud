import { PlaudTokenData } from "./types";

export type PlaudAuthErrorCode = "INVALID_FORMAT" | "EXPIRED" | "UNKNOWN";

export class PlaudAuthError extends Error {
  constructor(public code: PlaudAuthErrorCode, message: string) {
    super(message);
    this.name = "PlaudAuthError";
  }
}

function decodeJwtExpiry(jwt: string): { iat: number; exp: number } {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new PlaudAuthError("INVALID_FORMAT", "JWT 형식이 아닙니다.");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "===".slice((b64.length + 3) % 4);
  let payload: { iat?: number; exp?: number };
  try {
    payload = JSON.parse(atob(padded));
  } catch {
    throw new PlaudAuthError("INVALID_FORMAT", "JWT 페이로드를 해석할 수 없습니다.");
  }
  return { iat: payload.iat ?? 0, exp: payload.exp ?? 0 };
}

/**
 * 사용자가 붙여넣은 raw access_token(JWT) 문자열을 검증·파싱해서
 * PlaudTokenData 형태로 만든다. 만료 시 에러. region은 일단 "us"로 두고
 * 호출자가 getUserInfo로 검증하면서 실제 region을 확정한다.
 */
export function parseAndValidateToken(rawToken: string): PlaudTokenData {
  const cleaned = rawToken.trim().replace(/^Bearer\s+/i, "");
  if (!cleaned) {
    throw new PlaudAuthError("INVALID_FORMAT", "토큰이 비어 있습니다.");
  }
  if (!/^eyJ/.test(cleaned)) {
    throw new PlaudAuthError("INVALID_FORMAT", "JWT 형식이 아닙니다. 'eyJ'로 시작하는 토큰을 붙여넣어 주세요.");
  }
  const { iat, exp } = decodeJwtExpiry(cleaned);
  const expiresAt = exp * 1000;
  if (expiresAt <= Date.now()) {
    throw new PlaudAuthError("EXPIRED", "토큰이 이미 만료되었습니다. Plaud 웹앱에서 새 토큰을 받아 주세요.");
  }
  return {
    accessToken: cleaned,
    tokenType: "Bearer",
    issuedAt: iat * 1000,
    expiresAt,
    region: "us",
  };
}

export function isTokenExpired(token: PlaudTokenData): boolean {
  return Date.now() >= token.expiresAt;
}
