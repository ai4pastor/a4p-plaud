import { Notice } from "obsidian";
import {
  PlaudRecording,
  PlaudRecordingDetail,
  PlaudRegion,
  PlaudTokenData,
  PlaudTranscriptSegment,
  PlaudUserInfo,
} from "./types";
import {
  fileIdArgName,
  mcpEnsureToolSchemas,
  mcpToolCall,
  McpToolResult,
  PlaudMcpError,
} from "./mcp";

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

// ─────────────────────────────────────────── 파일 ID 인자명 자가 적응

/** 인자명 검증 실패로 보이는 에러인지 (pydantic 류 메시지) */
function looksLikeArgError(e: unknown): boolean {
  if (!(e instanceof PlaudMcpError) || e.code !== "RPC_ERROR") return false;
  return /field required|input should|unexpected keyword|missing|invalid params|validation/i.test(
    e.message
  );
}

const ID_ARG_CANDIDATES = ["file_id", "fileId", "id", "recording_id"];
/** 도구별로 성공이 확인된 인자명 캐시 */
const resolvedIdArg: Map<string, string> = new Map();

/**
 * 파일 ID 하나를 받는 도구를 인자명 모른 채 호출한다.
 * tools/list 스키마 → 캐시 → 후보 순회 순서로 자가 적응.
 */
async function callWithFileId(
  token: PlaudTokenData,
  tool: string,
  id: string
): Promise<McpToolResult> {
  const tried = new Set<string>();
  const candidates: string[] = [];

  const cached = resolvedIdArg.get(tool);
  if (cached) candidates.push(cached);

  await mcpEnsureToolSchemas(token);
  const fromSchema = fileIdArgName(tool);
  if (fromSchema && !candidates.includes(fromSchema)) candidates.push(fromSchema);

  for (const c of ID_ARG_CANDIDATES) {
    if (!candidates.includes(c)) candidates.push(c);
  }

  let lastErr: unknown = null;
  for (const argName of candidates) {
    if (tried.has(argName)) continue;
    tried.add(argName);
    try {
      const res = await mcpToolCall(token, tool, { [argName]: id });
      if (resolvedIdArg.get(tool) !== argName) {
        resolvedIdArg.set(tool, argName);
        console.log(`[A4P Plaud] ${tool} 인자명 확정: ${argName}`);
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (looksLikeArgError(e)) {
        console.warn(`[A4P Plaud] ${tool} 인자명 '${argName}' 거부 — 다음 후보 시도`, (e as Error).message);
        continue;
      }
      throw e; // 인자명 문제가 아니면 그대로 전파
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new PlaudMcpError("RPC_ERROR", `${tool} 호출 실패 (모든 인자명 후보 거부)`);
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

/**
 * raw 텍스트 폴백용 — JSON(배열/객체)이 아닌 실제 산문/마크다운인지.
 * "[]"·"{}"·구조화 JSON은 추출기가 이미 처리했으므로 폴백 대상이 아니다.
 */
function isProseText(s: string): boolean {
  const t = (s ?? "").trim();
  if (!t) return false;
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      JSON.parse(t);
      return false; // 유효한 JSON — 내용이 아니라 구조
    } catch {
      return true; // JSON처럼 시작하지만 평문
    }
  }
  return true;
}

/**
 * 문자열이 JSON으로 또 감싸여 있으면 반복적으로 풀어낸다 (이중/삼중 인코딩 대응).
 * 실측: get_transcript의 data_content는 "[{\"content\":...}]" 처럼 문자열로 감싸인 세그먼트 배열.
 */
function deepParse(v: unknown, depth = 3): unknown {
  let cur = v;
  for (let i = 0; i < depth && typeof cur === "string"; i++) {
    const t = cur.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) break;
    try {
      cur = JSON.parse(t);
    } catch {
      break;
    }
  }
  return cur;
}

/**
 * 본문 내 단독 `---` 수평선을 `***`로 치환 (마크다운 렌더링 동일).
 * import.ts의 중복 frontmatter 제거 안전망이 `---`를 yaml 구분자로 오인해
 * 사이 내용을 삭제하는 것을 방지한다.
 */
function neutralizeHr(s: string): string {
  return s.replace(/^[ \t]*-{3,}[ \t]*$/gm, "***");
}

/**
 * AI 요약 본문 안의 `[mm:ss]`/`[h:mm:ss]` 타임스탬프 제거 (텍스트만 남김).
 * 트랜스크립트 섹션의 타임스탬프는 유지하므로 요약 추출에만 사용한다.
 */
function stripTimestamps(s: string): string {
  return s
    // 타임스탬프만 있는 줄 제거
    .replace(/^[ \t]*\[\d{1,2}:\d{2}(?::\d{2})?\][ \t]*\r?\n/gm, "")
    // 줄 앞머리에 붙은 타임스탬프 제거
    .replace(/^[ \t]*\[\d{1,2}:\d{2}(?::\d{2})?\][ \t]*/gm, "");
}

/** ms → "m:ss" 또는 "h:mm:ss" */
export function msToClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** {content, start_time, end_time, speaker} 형태의 세그먼트 배열인지 */
function looksLikeSegments(arr: unknown[]): arr is Record<string, unknown>[] {
  if (arr.length === 0) return false;
  const first = obj(arr[0]);
  const hasText = typeof (first.content ?? first.text ?? first.sentence) === "string";
  const hasTime = first.start_time !== undefined || first.end_time !== undefined;
  return hasText && hasTime;
}

/** 세그먼트 배열 → "[m:ss] (화자) 내용" 줄들 */
function formatSegments(segs: Record<string, unknown>[]): string {
  const lines: string[] = [];
  for (const s of segs) {
    const text = firstString(s, ["content", "text", "sentence"]);
    if (!text || !text.trim()) continue;
    const startMs = firstNumber(s, ["start_time", "start", "begin"]);
    const speaker = firstString(s, ["speaker", "speaker_name", "original_speaker", "role"]);
    const stamp = startMs !== undefined ? `[${msToClock(startMs)}] ` : "";
    lines.push(`${stamp}${speaker ? `${speaker}: ` : ""}${text.trim()}`);
  }
  return lines.join("\n");
}

function normalizeSegments(raw: Record<string, unknown>[]): PlaudTranscriptSegment[] {
  const out: PlaudTranscriptSegment[] = [];
  for (const s of raw) {
    const content = firstString(s, ["content", "text", "sentence"]);
    if (!content || !content.trim()) continue;
    out.push({
      content: content.trim(),
      start_time: firstNumber(s, ["start_time", "start", "begin"]) ?? 0,
      end_time: firstNumber(s, ["end_time", "end"]) ?? 0,
      speaker: firstString(s, ["speaker", "speaker_name", "original_speaker", "role"]),
    });
  }
  return out;
}

interface TranscriptData {
  text: string;
  segments: PlaudTranscriptSegment[] | null;
}

/**
 * 전사 추출. 실측 구조:
 * [{ data_id, data_type, data_content: "<세그먼트 JSON 문자열>" }, ...]
 * 세그먼트: { content, start_time(ms), end_time(ms), speaker }
 * 타임스탬프 점프를 위해 평문과 세그먼트 배열을 함께 반환한다.
 */
function extractTranscriptData(input: unknown): TranscriptData {
  const parsed = deepParse(input);
  if (typeof parsed === "string") {
    return { text: neutralizeHr(parsed.trim()), segments: null };
  }

  if (Array.isArray(parsed)) {
    if (looksLikeSegments(parsed)) {
      const segs = normalizeSegments(parsed);
      return { text: formatSegments(parsed), segments: segs.length ? segs : null };
    }
    // data 아이템 배열 — data_content 안의 진짜 내용을 꺼낸다
    const parts: string[] = [];
    const allSegs: PlaudTranscriptSegment[] = [];
    for (const item of parsed) {
      const o = obj(item);
      const inner = deepParse(o.data_content ?? o.content ?? o.text);
      if (Array.isArray(inner) && looksLikeSegments(inner)) {
        parts.push(formatSegments(inner));
        allSegs.push(...normalizeSegments(inner));
      } else if (typeof inner === "string" && inner.trim()) {
        parts.push(neutralizeHr(inner.trim()));
      }
    }
    return { text: parts.join("\n\n"), segments: allSegs.length ? allSegs : null };
  }

  const o = obj(parsed);
  const direct = o.transcript ?? o.text ?? o.content ?? o.full_text ?? o.plain_text ?? o.data_content;
  if (direct !== undefined) {
    const inner = deepParse(direct);
    if (Array.isArray(inner) && looksLikeSegments(inner)) {
      const segs = normalizeSegments(inner);
      return { text: formatSegments(inner), segments: segs.length ? segs : null };
    }
    if (typeof inner === "string" && inner.trim()) {
      return { text: neutralizeHr(inner.trim()), segments: null };
    }
  }
  const segs = o.segments ?? o.data;
  if (Array.isArray(segs) && looksLikeSegments(segs)) {
    const norm = normalizeSegments(segs);
    return { text: formatSegments(segs), segments: norm.length ? norm : null };
  }
  return { text: "", segments: null };
}

/**
 * 요약 추출. 실측 구조:
 * [{ data_type: "auto_sum_note", data_title: "Summary", data_content: "### 마크다운...", ... }]
 */
function extractSummary(input: unknown): string | undefined {
  const parsed = deepParse(input);
  if (typeof parsed === "string") return stripTimestamps(neutralizeHr(parsed.trim())) || undefined;

  const items = Array.isArray(parsed) ? parsed : [obj(parsed).note ?? obj(parsed).data ?? parsed];
  const parts: string[] = [];
  for (const it of items) {
    const o = obj(it);
    const content = firstString(o, ["data_content", "summary", "ai_summary", "content", "text", "overview"]);
    if (content && content.trim()) parts.push(stripTimestamps(neutralizeHr(content.trim())));
    const actions = o.action_items ?? o.actions ?? o.todos;
    if (Array.isArray(actions) && actions.length) {
      const lines = (actions as unknown[])
        .map((a) => (typeof a === "string" ? a : firstString(obj(a), ["text", "content", "title"]) ?? ""))
        .filter(Boolean);
      if (lines.length) parts.push("### Action Items\n" + lines.map((l) => `- ${l}`).join("\n"));
    }
  }
  return parts.join("\n\n") || undefined;
}

let loggedDetailSample = false;
let loggedTranscriptSample = false;
let loggedNoteSample = false;
let notifiedTranscriptError = false;

export async function getRecordingDetail(
  token: PlaudTokenData,
  id: string
): Promise<PlaudRecordingDetail> {
  try {
    const fileRes = await callWithFileId(token, "get_file", id);
    if (!loggedDetailSample) {
      console.log("[A4P Plaud] get_file raw (필드 매핑 확인용)", fileRes.json ?? fileRes.text);
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
    let segments: PlaudTranscriptSegment[] | null = null;
    try {
      const tr = await callWithFileId(token, "get_transcript", id);
      if (!loggedTranscriptSample) {
        console.log("[A4P Plaud] get_transcript raw (필드 매핑 확인용)", tr.json ?? tr.text.slice(0, 800));
        loggedTranscriptSample = true;
      }
      const data = extractTranscriptData(tr.json ?? tr.text);
      transcript = data.text;
      segments = data.segments;
      // 구조 추출 실패 시 raw 텍스트 폴백 (마크다운/평문 전사 대응)
      // 단, "[]"/"{}" 같은 JSON 찌꺼기는 내용이 아님 — 전사 없음으로 둬야 STT 버튼이 뜬다
      if (!transcript && isProseText(tr.text)) {
        transcript = tr.text.trim();
      }
    } catch (e) {
      console.error("[A4P Plaud] get_transcript 실패", e);
      if (!notifiedTranscriptError) {
        notifiedTranscriptError = true;
        const msg = e instanceof Error ? e.message : String(e);
        new Notice(`Plaud 전사 불러오기 실패: ${msg}\n(콘솔 로그를 확인해 주세요)`);
      }
    }

    let summary: string | undefined;
    try {
      const note = await callWithFileId(token, "get_note", id);
      if (!loggedNoteSample) {
        console.log("[A4P Plaud] get_note raw (필드 매핑 확인용)", note.json ?? note.text.slice(0, 800));
        loggedNoteSample = true;
      }
      summary = extractSummary(note.json ?? note.text);
      if (!summary && isProseText(note.text)) {
        summary = note.text.trim();
      }
    } catch (e) {
      console.warn("[A4P Plaud] get_note 실패(무시)", e);
    }

    return {
      ...base,
      transcript,
      summary,
      segments: segments ?? undefined,
      is_trans: base.is_trans || !!transcript,
    };
  } catch (e) {
    wrapMcpError(e);
  }
}

export async function getMp3Url(token: PlaudTokenData, id: string): Promise<string | null> {
  try {
    const { json } = await callWithFileId(token, "get_file", id);
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
