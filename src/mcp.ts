import { requestUrl } from "obsidian";
import { PlaudTokenData, PLAUD_MCP_ENDPOINT } from "./types";

/**
 * Plaud 공식 MCP 서버에 대한 Streamable HTTP JSON-RPC 클라이언트.
 * - 모든 요청: POST /mcp, Authorization: Bearer, Accept: application/json + text/event-stream.
 * - 응답은 순수 JSON 또는 SSE(text/event-stream) 프레임일 수 있어 둘 다 파싱한다.
 * - 401 시 등록된 reauth 핸들러(refresh token 로그인)로 새 토큰을 받아 1회 재시도.
 */

export type PlaudMcpErrorCode = "UNAUTHORIZED" | "NETWORK" | "RPC_ERROR" | "BAD_RESPONSE";

export class PlaudMcpError extends Error {
  constructor(
    public code: PlaudMcpErrorCode,
    message: string,
    public httpStatus?: number
  ) {
    super(message);
    this.name = "PlaudMcpError";
  }
}

type ReauthHandler = () => Promise<PlaudTokenData | null>;
let reauthHandler: ReauthHandler | null = null;
export function setReauthHandler(handler: ReauthHandler | null): void {
  reauthHandler = handler;
}

const PROTOCOL_VERSION = "2025-06-18";
let sessionId: string | null = null;
let initialized = false;
let rpcCounter = 0;
/** tools/list 로 받은 도구별 inputSchema 캐시 */
let toolSchemas: Map<string, Record<string, unknown>> | null = null;

/** 세션 상태 초기화 (로그아웃·토큰 교체 시) */
export function resetMcpSession(): void {
  sessionId = null;
  initialized = false;
  toolSchemas = null;
}

interface RpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

/** SSE 프레임 또는 순수 JSON 본문에서 JSON-RPC 응답 객체를 추출한다. */
function parseRpcBody(text: string): RpcResponse | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  // 순수 JSON
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as RpcResponse;
    } catch {
      // SSE일 수 있음 → 아래로
    }
  }
  // SSE: "event: ...\ndata: {...}\n\n" 형태. 마지막 data 라인의 JSON 사용.
  let last: RpcResponse | null = null;
  for (const line of trimmed.split(/\r?\n/)) {
    const m = line.match(/^data:\s?(.*)$/);
    if (!m) continue;
    const payload = m[1].trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      last = JSON.parse(payload) as RpcResponse;
    } catch {
      // skip malformed frame
    }
  }
  return last;
}

interface RpcOptions {
  /** notification(응답 기대 안 함)이면 true */
  notification?: boolean;
  /** 401 재인증 재시도 비활성 (refresh 자체 호출 등) */
  noReauth?: boolean;
}

async function rawPost(
  token: string,
  payload: Record<string, unknown>
): Promise<{ status: number; text: string; headers: Record<string, string> }> {
  try {
    const res = await requestUrl({
      url: PLAUD_MCP_ENDPOINT,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(payload),
      throw: false,
    });
    return { status: res.status, text: res.text ?? "", headers: res.headers ?? {} };
  } catch (e) {
    throw new PlaudMcpError("NETWORK", "Plaud MCP 서버에 연결할 수 없습니다.");
  }
}

/**
 * JSON-RPC 호출. 401이면 reauth로 토큰을 갱신하고 세션을 다시 열어 1회 재시도한다.
 * 갱신된 토큰을 호출자에게 알리기 위해 사용한 토큰을 함께 반환한다.
 */
async function rpc(
  tokenData: PlaudTokenData,
  method: string,
  params: Record<string, unknown> | undefined,
  opts: RpcOptions = {}
): Promise<{ result: Record<string, unknown>; token: PlaudTokenData }> {
  let token = tokenData;
  let reauthTried = false;

  for (;;) {
    const payload: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;
    if (!opts.notification) payload.id = ++rpcCounter;

    const res = await rawPost(token.accessToken, payload);

    // 세션 헤더 갱신 (서버가 발급/회전할 수 있음)
    const sid = res.headers["mcp-session-id"] ?? res.headers["Mcp-Session-Id"];
    if (sid) sessionId = sid;

    if (res.status === 401) {
      if (!opts.noReauth && !reauthTried && reauthHandler) {
        reauthTried = true;
        const fresh = await reauthHandler();
        if (fresh) {
          token = fresh;
          resetMcpSession();
          await ensureSession(token);
          continue;
        }
      }
      throw new PlaudMcpError("UNAUTHORIZED", "Plaud 인증이 만료되었습니다. 다시 로그인해 주세요.", 401);
    }

    if (opts.notification) {
      return { result: {}, token };
    }

    if (res.status < 200 || res.status >= 300) {
      console.warn("[A4P Plaud] MCP HTTP 오류", { method, status: res.status, body: res.text.slice(0, 500) });
      throw new PlaudMcpError("BAD_RESPONSE", `MCP 응답 오류 (HTTP ${res.status}).`, res.status);
    }

    const parsed = parseRpcBody(res.text);
    if (!parsed) {
      throw new PlaudMcpError("BAD_RESPONSE", "MCP 응답을 해석할 수 없습니다.");
    }
    if (parsed.error) {
      throw new PlaudMcpError("RPC_ERROR", `MCP 오류: ${parsed.error.message ?? parsed.error.code}`);
    }
    return { result: parsed.result ?? {}, token };
  }
}

async function ensureSession(token: PlaudTokenData): Promise<void> {
  if (initialized && sessionId) return;
  // initialize (noReauth — 401이면 상위 호출의 reauth가 처리)
  await rpc(
    token,
    "initialize",
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "a4p-plaud", version: "0.4.0" },
    },
    { noReauth: true }
  );
  initialized = true;
  // initialized notification (실패해도 치명적 아님)
  try {
    await rpc(token, "notifications/initialized", undefined, { notification: true, noReauth: true });
  } catch (e) {
    console.warn("[A4P Plaud] notifications/initialized 실패(무시)", e);
  }
}

/** tools/list — 실제 도구명·인자 스키마 확인용(디버그). */
export async function mcpListTools(token: PlaudTokenData): Promise<Record<string, unknown>> {
  await ensureSession(token);
  const { result } = await rpc(token, "tools/list", {});
  console.log("[A4P Plaud] MCP tools/list", result);
  cacheToolSchemas(result);
  return result;
}

function cacheToolSchemas(listResult: Record<string, unknown>): void {
  const tools = listResult.tools as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tools)) return;
  toolSchemas = new Map();
  for (const t of tools) {
    const name = t.name as string | undefined;
    const schema = (t.inputSchema ?? t.input_schema) as Record<string, unknown> | undefined;
    if (name && schema) toolSchemas.set(name, schema);
  }
}

/** tools/list 1회 호출로 스키마 캐시 확보 (이미 있으면 재사용). 실패해도 throw하지 않음. */
export async function mcpEnsureToolSchemas(token: PlaudTokenData): Promise<void> {
  if (toolSchemas) return;
  try {
    await ensureSession(token);
    const { result } = await rpc(token, "tools/list", {});
    cacheToolSchemas(result);
  } catch (e) {
    console.warn("[A4P Plaud] tools/list 스키마 캐시 실패(무시)", e);
  }
}

/**
 * 도구 inputSchema에서 파일 ID에 해당하는 인자명을 찾는다.
 * required 중 'id' 포함 속성 우선, 없으면 전체 속성에서 탐색. 못 찾으면 null.
 */
export function fileIdArgName(toolName: string): string | null {
  const schema = toolSchemas?.get(toolName);
  if (!schema) return null;
  const props = schema.properties as Record<string, unknown> | undefined;
  if (!props) return null;
  const names = Object.keys(props);
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const isIdLike = (n: string) => /(^|_)id$|^id$|Id$/.test(n) || n.toLowerCase().includes("file");
  const fromRequired = required.find(isIdLike);
  if (fromRequired) return fromRequired;
  return names.find(isIdLike) ?? null;
}

export interface McpToolResult {
  /** content[].text 를 모두 이어붙인 문자열 (대개 JSON) */
  text: string;
  /** text를 JSON.parse 시도한 결과 (실패 시 null) */
  json: unknown;
  raw: Record<string, unknown>;
  /** 재시도 중 토큰이 갱신됐다면 새 토큰 (없으면 입력 토큰) */
  token: PlaudTokenData;
}

/** tools/call 후 content 텍스트를 추출·파싱해 돌려준다. */
export async function mcpToolCall(
  tokenData: PlaudTokenData,
  name: string,
  args: Record<string, unknown> = {}
): Promise<McpToolResult> {
  await ensureSession(tokenData);
  const { result, token } = await rpc(tokenData, "tools/call", { name, arguments: args });

  const content =
    (result.content as Array<{ type?: string; text?: string; resource?: { text?: string } }> | undefined) ?? [];
  const text = content
    .map((c) => (typeof c.text === "string" ? c.text : c.resource?.text ?? ""))
    .filter(Boolean)
    .join("");

  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  // structuredContent를 주는 서버도 있음 — 우선 사용
  if (json === null && result.structuredContent) {
    json = result.structuredContent;
  }

  if (result.isError) {
    console.warn("[A4P Plaud] MCP tool isError", { name, text });
    throw new PlaudMcpError("RPC_ERROR", `MCP 도구 오류(${name}): ${text || "unknown"}`);
  }

  return { text, json, raw: result, token };
}
