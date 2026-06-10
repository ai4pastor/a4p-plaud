import {
  PlaudRecording,
  PlaudRecordingDetail,
  PlaudRegion,
  PlaudTokenData,
  PlaudUserInfo,
} from "./types";
import { mcpToolCall, PlaudMcpError } from "./mcp";

/**
 * 기존 api.plaud.ai 직접 호출을 공식 MCP 도구 호출로 대체한 어댑터.
 * view.ts / import.ts 가 쓰던 함수 시그니처를 그대로 유지한다.
 *
 * ⚠️ MCP 도구의 정확한 이름·인자·응답 필드는 서버 비공개라 docs 기준 추정 + 방어적 파싱.
 *    첫 응답을 콘솔에 raw 로깅하므로, 실제 구조 확인 후 매핑을 교정한다(mcpListTools 도 참고).
 */

export type PlaudApiErrorCode =
  | "UNAUTHORIZED"
  | "NETWORK"
  | "BAD_RESPONSE"
  | "UNKNOWN";

export class PlaudApiError extends Error {
  constructor(
    public code: PlaudApiErrorCode,
    message: string,
    public httpStatus?: number
  ) {
    super(message);
    this.name = "PlaudApiError";
  }
}

// ─────────────────────────────────────────── 파싱 헬퍼

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function firstString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

function firstNumber(o: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number") return v;
    if (typeof v === "string" && v && !isNaN(Number(v))) return Number(v);
  }
  return undefined;
}

/** epoch(초/ms) 또는 ISO 문자열 → epoch ms */
function parseTime(v: unknown): number {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const n = Number(v);
    if (!isNaN(n) && v.trim() !== "") return n < 1e12 ? n * 1000 : n;
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  return 0;
}

/** 다양한 래핑에서 배열을 끄집어낸다. */
function asArray(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  const o = obj(json);
  for (const k of ["files", "data_file_list", "data", "items", "results", "recordings", "list"]) {
    if (Array.isArray(o[k])) return o[k] as Record<string, unknown>[];
    // 한 단계 더 중첩 (data.files 등)
    const inner = obj(o[k]);
    for (const k2 of ["files", "items", "list", "data_file_list"]) {
      if (Array.isArray(inner[k2])) return inner[k2] as Record<string, unknown>[];
    }
  }
  return [];
}

function normalizeRecording(raw: Record<string, unknown>): PlaudRecording | null {
  const id = firstString(raw, ["file_id", "id", "fileId", "_id", "uuid"]);
  if (!id) return null;
  const startRaw =
    raw.start_time ?? raw.created_at ?? raw.create_time ?? raw.record_time ?? raw.date ?? raw.time;
  const start = parseTime(startRaw);
  const endRaw = raw.end_time ?? raw.updated_at ?? raw.edit_time;
  const end = endRaw !== undefined ? parseTime(endRaw) : start;
  return {
    id,
    filename: firstString(raw, ["file_name", "filename", "name", "title"]) ?? id,
    fullname: firstString(raw, ["fullname", "full_name"]),
    filesize: firstNumber(raw, ["file_size", "filesize", "size"]) ?? 0,
    duration: firstNumber(raw, ["duration", "duration_ms", "length", "audio_duration"]) ?? 0,
    start_time: start,
    end_time: end,
    is_trash: Boolean(raw.is_trash ?? raw.trashed ?? false),
    is_trans: Boolean(
      raw.is_trans ?? raw.has_transcript ?? raw.transcribed ?? raw.is_transcribed ?? false
    ),
    is_summary: Boolean(raw.is_summary ?? raw.has_summary ?? raw.summarized ?? false),
    keywords: Array.isArray(raw.keywords)
      ? (raw.keywords as string[])
      : Array.isArray(raw.tags)
        ? (raw.tags as string[])
        : undefined,
    serial_number: firstString(raw, ["serial_number", "sn", "device_sn"]),
  };
}

function wrapMcpError(e: unknown): never {
  if (e instanceof PlaudMcpError) {
    if (e.code === "UNAUTHORIZED") throw new PlaudApiError("UNAUTHORIZED", e.message, 401);
    if (e.code === "NETWORK") throw new PlaudApiError("NETWORK", e.message);
    throw new PlaudApiError("BAD_RESPONSE", e.message);
  }
  throw new PlaudApiError("UNKNOWN", e instanceof Error ? e.message : "알 수 없는 오류");
}

// ─────────────────────────────────────────── 공개 API (기존 시그니처 유지)

export async function getUserInfo(
  token: PlaudTokenData
): Promise<{ user: PlaudUserInfo; region: PlaudRegion }> {
  try {
    const { json } = await mcpToolCall(token, "get_current_user", {});
    const u = obj(json);
    const user = obj(u.user ?? u.data ?? u);
    return {
      user: {
        id: firstString(user, ["id", "user_id", "uid"]) ?? "",
        nickname: firstString(user, ["nickname", "name", "display_name"]) ?? "",
        email: firstString(user, ["email", "username", "mail"]) ?? "",
        country: firstString(user, ["country", "region", "locale"]) ?? "",
        membership_type:
          firstString(user, ["membership_type", "membership", "plan", "tier"]) ?? "unknown",
      },
      region: "",
    };
  } catch (e) {
    wrapMcpError(e);
  }
}

let loggedListSample = false;

export async function listRecordings(token: PlaudTokenData): Promise<PlaudRecording[]> {
  try {
    const recordings: PlaudRecording[] = [];
    const seen = new Set<string>();
    let pageSize = 0;
    const MAX_PAGES = 500; // 안전장치 (중복/빈 페이지에서 먼저 종료)

    // page는 1-based (서버 검증: page >= 1)
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { json } = await mcpToolCall(token, "list_files", {
        limit: 100,
        count: 100,
        page_size: 100,
        page,
      });
      const batch = asArray(json);
      if (page === 1 && !loggedListSample) {
        console.log("[A4P Plaud] list_files page1 개수:", batch.length, "첫 항목 raw:", batch[0]);
        loggedListSample = true;
        pageSize = batch.length;
      }
      if (batch.length === 0) break;

      let added = 0;
      for (const raw of batch) {
        const rec = normalizeRecording(raw);
        if (!rec || seen.has(rec.id)) continue;
        seen.add(rec.id);
        added++;
        if (!rec.is_trash) recordings.push(rec);
      }

      // 새 항목이 없으면(= page 파라미터가 안 먹혀 같은 페이지 반복) 종료
      if (added === 0) break;
      // 페이지가 첫 페이지보다 작으면 마지막 페이지
      if (pageSize > 0 && batch.length < pageSize) break;
    }

    console.log(`[A4P Plaud] listRecordings 총 ${recordings.length}개 수집`);
    return recordings;
  } catch (e) {
    wrapMcpError(e);
  }
}

function extractTranscript(json: unknown): string {
  if (typeof json === "string") return json;
  const o = obj(json);
  const direct = firstString(o, ["transcript", "text", "content", "full_text", "plain_text"]);
  if (direct) return direct;
  // 세그먼트(화자/타임스탬프) 배열 조합
  const segs =
    (Array.isArray(o.segments) && o.segments) ||
    (Array.isArray(o.transcript) && o.transcript) ||
    (Array.isArray(o.data) && o.data) ||
    null;
  if (segs) {
    const lines: string[] = [];
    for (const s of segs as Record<string, unknown>[]) {
      const speaker = firstString(s, ["speaker", "speaker_name", "role"]);
      const text = firstString(s, ["text", "content", "sentence"]) ?? "";
      if (!text) continue;
      lines.push(speaker ? `${speaker}: ${text}` : text);
    }
    if (lines.length) return lines.join("\n");
  }
  return "";
}

function extractSummary(json: unknown): string | undefined {
  if (typeof json === "string") return json || undefined;
  const o = obj(json);
  const note = obj(o.note ?? o.data ?? o);
  const summary = firstString(note, ["summary", "ai_summary", "content", "text", "overview"]);
  const actions = note.action_items ?? note.actions ?? note.todos;
  let result = summary ?? "";
  if (Array.isArray(actions) && actions.length) {
    const items = (actions as unknown[])
      .map((a) => (typeof a === "string" ? a : firstString(obj(a), ["text", "content", "title"]) ?? ""))
      .filter(Boolean);
    if (items.length) {
      result += (result ? "\n\n" : "") + "### Action Items\n" + items.map((i) => `- ${i}`).join("\n");
    }
  }
  return result || undefined;
}

let loggedDetailSample = false;

export async function getRecordingDetail(
  token: PlaudTokenData,
  id: string
): Promise<PlaudRecordingDetail> {
  try {
    const fileRes = await mcpToolCall(token, "get_file", { file_id: id });
    if (!loggedDetailSample) {
      console.log("[A4P Plaud] get_file raw (필드 매핑 확인용)", fileRes.json);
      loggedDetailSample = true;
    }
    const fileObj = obj((fileRes.json as Record<string, unknown>)?.file ?? fileRes.json);
    const base = normalizeRecording({ ...fileObj, id }) ?? {
      id,
      filename: id,
      filesize: 0,
      duration: 0,
      start_time: 0,
      end_time: 0,
      is_trash: false,
      is_trans: false,
      is_summary: false,
    };

    let transcript = "";
    try {
      const tr = await mcpToolCall(token, "get_transcript", { file_id: id });
      transcript = extractTranscript(tr.json ?? tr.text);
    } catch (e) {
      console.warn("[A4P Plaud] get_transcript 실패(무시)", e);
    }

    let summary: string | undefined;
    try {
      const note = await mcpToolCall(token, "get_note", { file_id: id });
      summary = extractSummary(note.json ?? note.text);
    } catch (e) {
      console.warn("[A4P Plaud] get_note 실패(무시)", e);
    }

    return { ...base, transcript, summary };
  } catch (e) {
    wrapMcpError(e);
  }
}

export async function getMp3Url(token: PlaudTokenData, id: string): Promise<string | null> {
  try {
    const { json } = await mcpToolCall(token, "get_file", { file_id: id });
    const o = obj((json as Record<string, unknown>)?.file ?? json);
    const url = firstString(o, [
      "download_url",
      "downloadUrl",
      "url",
      "audio_url",
      "audioUrl",
      "temp_url",
      "presigned_url",
      "file_url",
      "mp3_url",
      "media_url",
    ]);
    if (url) return url;
    // 중첩 객체 안에 들어있는 경우
    for (const k of ["data", "audio", "media", "file"]) {
      const nested = obj(o[k]);
      const nestedUrl = firstString(nested, ["download_url", "url", "audio_url", "temp_url"]);
      if (nestedUrl) return nestedUrl;
    }
    console.warn("[A4P Plaud] get_file 에 다운로드 URL 없음", json);
    return null;
  } catch (e) {
    if (e instanceof PlaudApiError && e.code === "UNAUTHORIZED") throw e;
    console.warn("[A4P Plaud] getMp3Url 실패", e);
    return null;
  }
}
