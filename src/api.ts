import { Notice, requestUrl } from "obsidian";
import {
  PlaudRecording,
  PlaudRecordingDetail,
  PlaudRegion,
  PlaudTokenData,
  PlaudTranscriptSegment,
  PlaudUserInfo,
  PLAUD_DEV_API_BASE,
} from "./types";

/**
 * Plaud 공식 개발자 API(REST) 클라이언트.
 * 공식 MCP/CLI가 쓰는 것과 동일한 표면: /open/third-party/files, /users/current.
 * v0.6.0에서 mcp.plaud.ai JSON-RPC 어댑터를 대체 — 파일 상세 한 번에
 * 메타 + 요약(note_list) + 전사(source_list) + 오디오 URL(presigned_url)을 받는다.
 * view.ts / import.ts 가 쓰던 함수 시그니처는 그대로 유지한다.
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

// ─────────────────────────────────────────── 인증 갱신 훅

type ReauthHandler = () => Promise<PlaudTokenData | null>;
let reauthHandler: ReauthHandler | null = null;
export function setReauthHandler(handler: ReauthHandler | null): void {
  reauthHandler = handler;
}

// ─────────────────────────────────────────── HTTP

/**
 * API 요청. 401이면 reauth(refresh token)로 새 토큰을 받아 1회 재시도한다.
 */
async function apiRequest(
  tokenData: PlaudTokenData,
  path: string,
  opts: { method?: string; allowEmpty?: boolean } = {}
): Promise<{ json: unknown; token: PlaudTokenData }> {
  let token = tokenData;
  let reauthTried = false;

  for (;;) {
    let res;
    try {
      res = await requestUrl({
        url: `${PLAUD_DEV_API_BASE}${path}`,
        method: opts.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          Accept: "application/json",
        },
        throw: false,
      });
    } catch {
      throw new PlaudApiError("NETWORK", "Plaud 서버에 연결할 수 없습니다.");
    }

    if (res.status === 401) {
      if (!reauthTried && reauthHandler) {
        reauthTried = true;
        const fresh = await reauthHandler();
        if (fresh) {
          token = fresh;
          continue;
        }
      }
      throw new PlaudApiError("UNAUTHORIZED", "Plaud 인증이 만료되었습니다. 다시 로그인해 주세요.", 401);
    }

    if (res.status < 200 || res.status >= 300) {
      console.warn("[A4P Plaud] API HTTP 오류", { path, status: res.status, body: (res.text ?? "").slice(0, 500) });
      throw new PlaudApiError("BAD_RESPONSE", `Plaud API 응답 오류 (HTTP ${res.status}).`, res.status);
    }

    let json: unknown = null;
    try {
      json = res.json;
    } catch {
      // json 게터가 파싱 실패 시 throw할 수 있음
    }
    if (json === null || json === undefined) {
      try {
        json = JSON.parse(res.text ?? "");
      } catch {
        if (!opts.allowEmpty) {
          throw new PlaudApiError("BAD_RESPONSE", "Plaud API 응답을 해석할 수 없습니다.");
        }
        json = null;
      }
    }
    return { json, token };
  }
}

const apiGet = (token: PlaudTokenData, path: string) => apiRequest(token, path);

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
  for (const k of ["data", "files", "data_file_list", "items", "results", "recordings", "list"]) {
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

/**
 * 문자열이 JSON으로 또 감싸여 있으면 반복적으로 풀어낸다 (이중 인코딩 대응).
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
 * 전사 추출 (source_list). mcp.plaud.ai 실측 구조와 동일 계열을 방어적으로 처리:
 * [{ data_id, data_type, data_content: "<세그먼트 JSON 문자열>" }, ...] 또는 세그먼트 배열 직접.
 * 세그먼트: { content, start_time(ms), end_time(ms), speaker }
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
 * 요약 추출 (note_list).
 * [{ data_type: "auto_sum_note", data_title: "Summary", data_content: "### 마크다운...", ... }] 계열.
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

// ─────────────────────────────────────────── 공개 API (기존 시그니처 유지)

export async function getUserInfo(
  token: PlaudTokenData
): Promise<{ user: PlaudUserInfo; region: PlaudRegion }> {
  const { json } = await apiGet(token, "/open/third-party/users/current");
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
}

/** 로그아웃 시 서버측 접근 권한도 회수 (best-effort). */
export async function revokeAccess(token: PlaudTokenData): Promise<void> {
  try {
    await apiRequest(token, "/open/third-party/users/current/revoke", {
      method: "POST",
      allowEmpty: true,
    });
  } catch (e) {
    console.warn("[A4P Plaud] revoke 실패(무시)", e);
  }
}

let loggedListSample = false;

export async function listRecordings(token: PlaudTokenData): Promise<PlaudRecording[]> {
  const recordings: PlaudRecording[] = [];
  const seen = new Set<string>();
  let pageSize = 0;
  const MAX_PAGES = 500; // 안전장치 (중복/빈 페이지에서 먼저 종료)

  // page는 1-based
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { json } = await apiGet(token, `/open/third-party/files/?page=${page}&page_size=100`);
    const batch = asArray(json);
    if (page === 1 && !loggedListSample) {
      console.log("[A4P Plaud] files page1 개수:", batch.length, "첫 항목 raw:", batch[0]);
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
}

/** 첫 페이지(최신 100개)만 — 새 녹음 감지 폴링용 경량 조회 */
export async function listRecentRecordings(token: PlaudTokenData): Promise<PlaudRecording[]> {
  const { json } = await apiGet(token, "/open/third-party/files/?page=1&page_size=100");
  const out: PlaudRecording[] = [];
  for (const raw of asArray(json)) {
    const rec = normalizeRecording(raw);
    if (rec && !rec.is_trash) out.push(rec);
  }
  return out;
}

let loggedDetailSample = false;
let notifiedTranscriptError = false;

/** 파일 상세 원본 — note_list/source_list/presigned_url 포함 (파일 객체 래핑 방어). */
async function fetchFileDetail(
  token: PlaudTokenData,
  id: string
): Promise<Record<string, unknown>> {
  const { json } = await apiGet(token, `/open/third-party/files/${encodeURIComponent(id)}`);
  if (!loggedDetailSample) {
    console.log("[A4P Plaud] file detail raw (필드 매핑 확인용)", json);
    loggedDetailSample = true;
  }
  const o = obj(json);
  return obj(o.file ?? o.data ?? o);
}

export async function getRecordingDetail(
  token: PlaudTokenData,
  id: string
): Promise<PlaudRecordingDetail> {
  const fileObj = await fetchFileDetail(token, id);
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
    const data = extractTranscriptData(fileObj.source_list ?? fileObj.transcript ?? fileObj.trans_result);
    transcript = data.text;
    segments = data.segments;
  } catch (e) {
    console.error("[A4P Plaud] 전사 추출 실패", e);
    if (!notifiedTranscriptError) {
      notifiedTranscriptError = true;
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`Plaud 전사 불러오기 실패: ${msg}\n(콘솔 로그를 확인해 주세요)`);
    }
  }

  let summary: string | undefined;
  try {
    summary = extractSummary(fileObj.note_list ?? fileObj.note ?? fileObj.summary);
  } catch (e) {
    console.warn("[A4P Plaud] 요약 추출 실패(무시)", e);
  }

  return {
    ...base,
    transcript,
    summary,
    segments: segments ?? undefined,
    is_trans: base.is_trans || !!transcript,
    is_summary: base.is_summary || !!summary,
    has_audio: !!firstString(fileObj, ["presigned_url", "download_url", "temp_url", "audio_url"]),
  };
}

export async function getMp3Url(token: PlaudTokenData, id: string): Promise<string | null> {
  try {
    const o = await fetchFileDetail(token, id);
    const url = firstString(o, [
      "presigned_url",
      "download_url",
      "downloadUrl",
      "url",
      "audio_url",
      "audioUrl",
      "temp_url",
      "file_url",
      "mp3_url",
      "media_url",
    ]);
    if (url) return url;
    // 중첩 객체 안에 들어있는 경우
    for (const k of ["data", "audio", "media", "file"]) {
      const nested = obj(o[k]);
      const nestedUrl = firstString(nested, ["presigned_url", "download_url", "url", "audio_url", "temp_url"]);
      if (nestedUrl) return nestedUrl;
    }
    console.warn("[A4P Plaud] 파일 상세에 다운로드 URL 없음", o);
    return null;
  } catch (e) {
    if (e instanceof PlaudApiError && e.code === "UNAUTHORIZED") throw e;
    console.warn("[A4P Plaud] getMp3Url 실패", e);
    return null;
  }
}
