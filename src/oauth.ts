import { requestUrl } from "obsidian";
import { PlaudAuthError } from "./auth";
import { PlaudTokenData, PLAUD_MCP_BASE } from "./types";

/**
 * Plaud 공식 MCP 서버(mcp.plaud.ai)에 대한 OAuth 2.1 클라이언트.
 * - 동적 클라이언트 등록(RFC 7591), PKCE(S256), public client(시크릿 없음).
 * - authorization_code 로 토큰 발급, refresh_token 으로 자동 갱신.
 * 엔드포인트는 /.well-known/oauth-authorization-server 로 확인됨.
 */

const AUTHORIZE_ENDPOINT = `${PLAUD_MCP_BASE}/authorize`;
const TOKEN_ENDPOINT = `${PLAUD_MCP_BASE}/token`;
const REGISTER_ENDPOINT = `${PLAUD_MCP_BASE}/register`;

interface NodeCryptoLike {
  randomBytes(n: number): Buffer;
  createHash(alg: string): { update(d: string): { digest(): Buffer } };
}

function nodeCrypto(): NodeCryptoLike {
  const w = window as unknown as { require?: (m: string) => unknown };
  const req = w.require ?? (typeof require === "function" ? require : null);
  if (!req) throw new PlaudAuthError("UNKNOWN", "이 환경에서는 crypto 모듈을 사용할 수 없습니다.");
  return req("crypto") as NodeCryptoLike;
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkce(): PkcePair {
  const c = nodeCrypto();
  const verifier = base64url(c.randomBytes(32)); // 43자
  const challenge = base64url(c.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function createState(): string {
  return base64url(nodeCrypto().randomBytes(16));
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function toTokenData(
  resp: TokenResponse,
  clientId: string,
  prevRefresh?: string
): PlaudTokenData {
  if (!resp.access_token) {
    throw new PlaudAuthError(
      "OAUTH_FAILED",
      `토큰 응답에 access_token이 없습니다. (${resp.error ?? "unknown"}: ${resp.error_description ?? ""})`
    );
  }
  const expiresIn = typeof resp.expires_in === "number" ? resp.expires_in : 3600;
  return {
    accessToken: resp.access_token,
    refreshToken: resp.refresh_token ?? prevRefresh ?? "",
    clientId,
    expiresAt: Date.now() + expiresIn * 1000,
    tokenType: resp.token_type ?? "Bearer",
  };
}

/** 동적 클라이언트 등록 → client_id 반환. (public client, 시크릿 없음) */
export async function registerClient(redirectUri: string): Promise<string> {
  let res;
  try {
    res = await requestUrl({
      url: REGISTER_ENDPOINT,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "A4P Plaud (Obsidian)",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      throw: false,
    });
  } catch {
    throw new PlaudAuthError("OAUTH_FAILED", "MCP 서버에 연결할 수 없습니다 (register).");
  }
  const data = (res.json ?? {}) as { client_id?: string; error?: string };
  if ((res.status === 200 || res.status === 201) && data.client_id) {
    return data.client_id;
  }
  console.warn("[A4P Plaud] register 실패", { status: res.status, body: res.text });
  throw new PlaudAuthError("OAUTH_FAILED", `클라이언트 등록 실패 (HTTP ${res.status}).`);
}

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
}): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
    state: opts.state,
  });
  return `${AUTHORIZE_ENDPOINT}?${p.toString()}`;
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  let res;
  try {
    res = await requestUrl({
      url: TOKEN_ENDPOINT,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      throw: false,
    });
  } catch {
    throw new PlaudAuthError("OAUTH_FAILED", "MCP 서버에 연결할 수 없습니다 (token).");
  }
  const data = (res.json ?? {}) as TokenResponse;
  if (res.status !== 200) {
    console.warn("[A4P Plaud] token 응답 비정상", { status: res.status, body: res.text });
  }
  return data;
}

export async function exchangeCode(opts: {
  code: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
}): Promise<PlaudTokenData> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.verifier,
  });
  return toTokenData(await postToken(body), opts.clientId);
}

export async function refreshAccessToken(opts: {
  refreshToken: string;
  clientId: string;
}): Promise<PlaudTokenData> {
  if (!opts.refreshToken) {
    throw new PlaudAuthError("REFRESH_FAILED", "refresh token이 없습니다. 다시 로그인해 주세요.");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
  });
  const resp = await postToken(body);
  if (!resp.access_token) {
    throw new PlaudAuthError("REFRESH_FAILED", "토큰 갱신에 실패했습니다. 다시 로그인해 주세요.");
  }
  return toTokenData(resp, opts.clientId, opts.refreshToken);
}
