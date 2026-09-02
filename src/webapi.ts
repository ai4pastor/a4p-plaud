import { requestUrl } from "obsidian";
import {
  extractSummary,
  extractTranscriptData,
  normalizeRecording,
} from "./api";
import { PlaudRecordingDetail, WebTokenData } from "./types";

/**
 * 비공식 Plaud 웹 API(api.plaud.ai) 클라이언트 — "감시 폴더 자동 업로드" 전용.
 *
 * ⚠️ 공식 개발자 API(platform.plaud.ai, src/api.ts)는 읽기 전용이라 업로드가 불가능하다.
 * 이 모듈은 Plaud 웹앱(web.plaud.ai)이 내부적으로 쓰는 API를 사용한다:
 * 업로드한 파일은 사용자 본인 Plaud 계정에 들어가고 요금제 전사 시간을 소모한다.
 * Plaud 측 변경으로 예고 없이 깨질 수 있으므로, 이 모듈이 실패해도
 * 기존 공식 API 기능에는 어떤 영향도 주지 않도록 완전히 분리한다.
 *
 * 엔드포인트 출처: 커뮤니티 역공학 구현
 * (github.com/arbuzmell/plaud-api, github.com/sergivalverde/plaud-toolkit)
 */

export const PLAUD_WEB_API_DEFAULT_BASE = "https://api.plaud.ai";
const WEB_ORIGIN = "https://web.plaud.ai";

export type WebApiErrorCode =
  | "UNAUTHORIZED"
  | "LOGIN_FAILED"
  | "NETWORK"
  | "BAD_RESPONSE"
  | "UPLOAD_FAILED"
  | "ANALYSIS_TIMEOUT";

export class PlaudWebApiError extends Error {
  constructor(
    public code: WebApiErrorCode,
    message: string,
    public httpStatus?: number
  ) {
    super(message);
    this.name = "PlaudWebApiError";
  }
}

/** 웹 API 세션 — 토큰 캐시·재로그인·리전 base 관리는 main.ts가 구현한다. */
export interface WebSession {
  /** 유효한 토큰 반환. forceRefresh 시 재로그인 시도(자격증명 있을 때). 실패 시 throw. */
  getToken(forceRefresh?: boolean): Promise<string>;
  getBase(): string;
  /** -302 리전 리다이렉트 시 base 교체 (설정에 persist) */
  setBase(url: string): Promise<void>;
}

// ─────────────────────────────────────────── 파싱 헬퍼 (로컬)

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** JWT payload에서 exp/iat 추출 → WebTokenData. 디코드 실패 시 25일 추정 수명. */
export function tokenDataFromJwt(jwt: string): WebTokenData {
  const now = Date.now();
  let expiresAt = now + 25 * 24 * 60 * 60 * 1000;
  let issuedAt = now;
  try {
    const payloadB64 = jwt.split(".")[1] ?? "";
    const normalized = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(
      Buffer.from(normalized, "base64").toString("utf8")
    ) as Record<string, unknown>;
    if (typeof payload.exp === "number") expiresAt = payload.exp * 1000;
    if (typeof payload.iat === "number") issuedAt = payload.iat * 1000;
  } catch {
    // 형식이 달라도 토큰 자체는 쓸 수 있으므로 추정값 유지
  }
  return { accessToken: jwt, expiresAt, issuedAt };
}

// ─────────────────────────────────────────── 로그인

/**
 * 이메일/비밀번호 로그인. ⚠️ Plaud 백엔드는 새 로그인 시 오래된 세션을 축출할 수
 * 있으므로(폰 앱 로그아웃 위험) 호출은 토큰 만료/401 시에만 해야 한다.
 */
export async function webLogin(
  base: string,
  email: string,
  password: string
): Promise<WebTokenData> {
  let res;
  try {
    res = await requestUrl({
      url: `${base}/auth/access-token`,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Origin: WEB_ORIGIN,
        Referer: `${WEB_ORIGIN}/`,
        "app-platform": "web",
      },
      body: `username=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`,
      throw: false,
    });
  } catch {
    throw new PlaudWebApiError("NETWORK", "Plaud 서버에 연결할 수 없습니다.");
  }
  const json = obj(safeJson(res));
  const token = typeof json.access_token === "string" ? json.access_token : "";
  if (res.status < 200 || res.status >= 300 || !token) {
    console.warn("[A4P Plaud] 웹 로그인 실패", { status: res.status, body: (res.text ?? "").slice(0, 300) });
    throw new PlaudWebApiError(
      "LOGIN_FAILED",
      "Plaud 웹 로그인에 실패했습니다. 이메일/비밀번호를 확인해 주세요. (구글·Apple 계정은 비밀번호 로그인이 불가할 수 있습니다 — 이 경우 '토큰 직접 붙여넣기'를 사용하세요)",
      res.status
    );
  }
  return tokenDataFromJwt(token);
}

// ─────────────────────────────────────────── 공통 요청

function safeJson(res: { json: unknown; text?: string }): unknown {
  try {
    if (res.json !== null && res.json !== undefined) return res.json;
  } catch {
    // json 게터가 throw할 수 있음
  }
  try {
    return JSON.parse(res.text ?? "");
  } catch {
    return null;
  }
}

interface WebRequestOpts {
  method?: string;
  /** JSON body — 객체면 캐시버스터 r이 자동 추가됨 (배열은 그대로) */
  json?: unknown;
}

/**
 * 웹 API 공통 요청. 브라우저 모방 헤더 + 401 재로그인 1회 + -302 리전 교체 1회.
 */
async function webRequest(
  session: WebSession,
  path: string,
  opts: WebRequestOpts = {}
): Promise<unknown> {
  let retried401 = false;
  let retried302 = false;

  for (;;) {
    const token = await session.getToken(retried401);
    let body: string | undefined;
    if (opts.json !== undefined) {
      const payload =
        opts.json && typeof opts.json === "object" && !Array.isArray(opts.json)
          ? { ...(opts.json as Record<string, unknown>), r: Math.random() }
          : opts.json;
      body = JSON.stringify(payload);
    }

    let res;
    try {
      res = await requestUrl({
        url: `${session.getBase()}${path}`,
        method: opts.method ?? "GET",
        headers: {
          // 웹앱과 동일하게 소문자 bearer
          Authorization: `bearer ${token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          Origin: WEB_ORIGIN,
          Referer: `${WEB_ORIGIN}/`,
          "app-platform": "web",
          "edit-from": "web",
        },
        body,
        throw: false,
      });
    } catch {
      throw new PlaudWebApiError("NETWORK", "Plaud 서버에 연결할 수 없습니다.");
    }

    if (res.status === 401 || res.status === 403) {
      if (!retried401) {
        retried401 = true;
        continue;
      }
      throw new PlaudWebApiError(
        "UNAUTHORIZED",
        "Plaud 웹 연결이 만료되었습니다. 설정에서 다시 연결해 주세요.",
        res.status
      );
    }

    if (res.status < 200 || res.status >= 300) {
      console.warn("[A4P Plaud] 웹 API HTTP 오류", {
        path,
        status: res.status,
        body: (res.text ?? "").slice(0, 500),
      });
      throw new PlaudWebApiError(
        "BAD_RESPONSE",
        `Plaud 웹 API 응답 오류 (HTTP ${res.status}).`,
        res.status
      );
    }

    const json = safeJson(res);
    const o = obj(json);

    // 리전 리다이렉트: {status:-302, data:{domains:{api:"https://api-euc1.plaud.ai"}}}
    if (o.status === -302 && !retried302) {
      const domains = obj(obj(o.data).domains);
      const nextBase = typeof domains.api === "string" ? domains.api : "";
      if (nextBase) {
        console.log("[A4P Plaud] 웹 API 리전 이동:", nextBase);
        await session.setBase(nextBase.replace(/\/+$/, ""));
        retried302 = true;
        continue;
      }
    }

    return json;
  }
}

// ─────────────────────────────────────────── 업로드

export type WebFileType = "MP3" | "OPUS";

export interface UploadArgs {
  data: ArrayBuffer;
  fileType: WebFileType;
  /** Plaud 앱에 표시될 녹음 이름 (확장자 없이) */
  filename: string;
  /** 녹음 시작 시각으로 기록할 epoch ms (보통 파일 mtime) */
  startTimeMs: number;
  onProgress?: (stage: "presign" | "put" | "merge" | "confirm", part?: number, totalParts?: number) => void;
}

function headerLookup(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return undefined;
}

/**
 * 멀티파트 업로드 전체 흐름: presign → part PUT → merge → confirm.
 * 반환된 fileId는 사용자 Plaud 계정의 새 녹음 id.
 */
export async function uploadAudio(
  session: WebSession,
  args: UploadArgs
): Promise<{ fileId: string; raw: Record<string, unknown> }> {
  const size = args.data.byteLength;
  args.onProgress?.("presign");
  const presignJson = await webRequest(session, "/file/get_upload_presigned_url", {
    method: "POST",
    json: { filesize: size, file_type: args.fileType },
  });
  const presign = obj(obj(presignJson).data);
  const partUrls = Array.isArray(presign.part_urls) ? (presign.part_urls as unknown[]) : [];
  const uploadId = presign.upload_id;
  const objectName = presign.object_name;
  if (partUrls.length === 0 || uploadId === undefined || objectName === undefined) {
    console.warn("[A4P Plaud] presign 응답 형식 불일치", presignJson);
    throw new PlaudWebApiError("UPLOAD_FAILED", "업로드 URL을 받지 못했습니다. (Plaud 웹 API 변경 가능성)");
  }

  // part_urls 개수에 맞춰 균등 분할 (마지막 파트가 나머지)
  const chunkSize = Math.ceil(size / partUrls.length);
  const parts: { Etag: string; PartNumber: number }[] = [];
  for (let i = 0; i < partUrls.length; i++) {
    const rawUrl = partUrls[i];
    const url =
      typeof rawUrl === "string"
        ? rawUrl
        : typeof obj(rawUrl).url === "string"
          ? (obj(rawUrl).url as string)
          : "";
    if (!url) throw new PlaudWebApiError("UPLOAD_FAILED", `업로드 파트 URL이 비었습니다 (part ${i + 1}).`);
    const chunk = args.data.slice(i * chunkSize, Math.min((i + 1) * chunkSize, size));
    args.onProgress?.("put", i + 1, partUrls.length);
    let putRes;
    try {
      putRes = await requestUrl({
        url,
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: chunk,
        throw: false,
      });
    } catch {
      throw new PlaudWebApiError("NETWORK", `업로드 중 연결이 끊어졌습니다 (part ${i + 1}/${partUrls.length}).`);
    }
    if (putRes.status < 200 || putRes.status >= 300) {
      throw new PlaudWebApiError("UPLOAD_FAILED", `파트 업로드 실패 (HTTP ${putRes.status}, part ${i + 1}).`, putRes.status);
    }
    const etag = headerLookup(putRes.headers ?? {}, "etag")?.replace(/"/g, "");
    if (!etag) {
      throw new PlaudWebApiError("UPLOAD_FAILED", `업로드 응답에 ETag가 없습니다 (part ${i + 1}).`);
    }
    parts.push({ Etag: etag, PartNumber: i + 1 });
  }

  args.onProgress?.("merge");
  await webRequest(session, "/file/merge_multipart", {
    method: "POST",
    json: { upload_id: uploadId, object_name: objectName, parts },
  });

  args.onProgress?.("confirm");
  const confirmJson = await webRequest(session, "/file/confirm_upload", {
    method: "POST",
    json: {
      upload_id: uploadId,
      object_name: objectName,
      // scene 101 = 웹앱 '오디오 가져오기'와 동일한 imported-audio 마커
      scene: 101,
      is_tmp: 0,
      support_mul_summ: true,
      file_type: args.fileType,
      filename: args.filename,
      start_time: args.startTimeMs,
      session_id: Math.floor(Date.now() / 1000),
      serial_number: cryptoRandomId(),
    },
  });
  const confirmed = obj(confirmJson);
  const fileObj = obj(confirmed.data ?? confirmed.file ?? confirmed);
  const fileId =
    typeof fileObj.id === "string" || typeof fileObj.id === "number"
      ? String(fileObj.id)
      : typeof fileObj.file_id === "string" || typeof fileObj.file_id === "number"
        ? String(fileObj.file_id)
        : "";
  if (!fileId) {
    console.warn("[A4P Plaud] confirm_upload 응답에 id 없음", confirmJson);
    throw new PlaudWebApiError(
      "UPLOAD_FAILED",
      "업로드는 됐지만 파일 ID를 받지 못했습니다. Plaud 앱에서 녹음이 보이는지 확인해 주세요."
    );
  }
  return { fileId, raw: fileObj };
}

function cryptoRandomId(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    // fall through
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─────────────────────────────────────────── 전사·요약 (transsumm)

function analysisInfo(language: string): Record<string, unknown> {
  return { language: language || "auto", diarization: 1, llm: "auto" };
}

/** 전사 설정을 파일에 기록 — transsumm 시작 전에 호출 (웹앱 동작 순서와 동일) */
export async function startAnalysis(
  session: WebSession,
  fileId: string,
  language: string
): Promise<void> {
  await webRequest(session, `/file/${encodeURIComponent(fileId)}`, {
    method: "PATCH",
    json: {
      extra_data: {
        tranConfig: {
          ...analysisInfo(language),
          type_type: "system",
          type: "REASONING-NOTE",
        },
      },
    },
  });
}

/**
 * 전사·요약 상태 확인. 서버가 작업을 큐잉/진행/완료 중 어느 상태든 같은 엔드포인트로 응답한다.
 * 완료 판정: status===1 또는 (msg==="success" && data_result 존재).
 */
export async function checkAnalysis(
  session: WebSession,
  fileId: string,
  language: string
): Promise<{ complete: boolean; raw: Record<string, unknown> }> {
  const json = await webRequest(session, `/ai/transsumm/${encodeURIComponent(fileId)}`, {
    method: "POST",
    json: {
      is_reload: 0,
      summ_type: "REASONING-NOTE",
      summ_type_type: "system",
      info: JSON.stringify(analysisInfo(language)),
      support_mul_summ: true,
    },
  });
  const o = obj(json);
  const complete =
    o.status === 1 || (o.msg === "success" && ("data_result" in o || "data" in o && obj(o.data).trans_result !== undefined));
  return { complete, raw: o };
}

/**
 * ⚠️ 필수 단계: transsumm 결과를 파일 레코드에 되저장한다.
 * 웹앱도 이렇게 동작하며, 이 PATCH를 생략하면 전사가 클라우드 레코드에 남지 않아
 * 공식 API·웹앱·폰 앱 어디서도 보이지 않는다.
 */
export async function saveAnalysisResults(
  session: WebSession,
  fileId: string,
  analysisRaw: Record<string, unknown>
): Promise<void> {
  const d = obj(analysisRaw.data_result ?? analysisRaw.data ?? analysisRaw);
  const body: Record<string, unknown> = { support_mul_summ: true };
  for (const k of ["trans_result", "ai_content", "outline_result"]) {
    if (d[k] !== undefined) body[k] = d[k];
  }
  const extra: Record<string, unknown> = {};
  if (d.task_id_info !== undefined) extra.task_id_info = d.task_id_info;
  if (d.aiContentHeader !== undefined) extra.aiContentHeader = d.aiContentHeader;
  if (Object.keys(extra).length) body.extra_data = extra;
  if (!("trans_result" in body) && !("ai_content" in body)) {
    console.warn("[A4P Plaud] transsumm 결과에 저장할 내용 없음 — 되저장 생략", analysisRaw);
    return;
  }
  await webRequest(session, `/file/${encodeURIComponent(fileId)}`, {
    method: "PATCH",
    json: body,
  });
}

// ─────────────────────────────────────────── 조회 (임포트 폴백용)

/** 파일 raw 조회 — POST /file/list에 id 배열 */
export async function getWebFileRaw(
  session: WebSession,
  fileId: string
): Promise<Record<string, unknown>> {
  const json = await webRequest(session, "/file/list", {
    method: "POST",
    json: [fileId],
  });
  const o = obj(json);
  const arr = Array.isArray(o.data_file_list)
    ? (o.data_file_list as unknown[])
    : Array.isArray(o.data)
      ? (o.data as unknown[])
      : Array.isArray(json)
        ? (json as unknown[])
        : [];
  const first = obj(arr[0]);
  if (!Object.keys(first).length) {
    console.warn("[A4P Plaud] 웹 파일 조회 응답 형식 불일치", json);
    throw new PlaudWebApiError("BAD_RESPONSE", "업로드한 파일 정보를 조회하지 못했습니다.");
  }
  return first;
}

/**
 * 웹 API 파일 raw → PlaudRecordingDetail 어댑터.
 * 공식 API detail 조회가 실패(미로그인·id 불일치)할 때의 임포트 폴백.
 */
export function webDetailToRecordingDetail(raw: Record<string, unknown>): PlaudRecordingDetail {
  const id =
    typeof raw.id === "string" || typeof raw.id === "number" ? String(raw.id) : "";
  const base = normalizeRecording({ ...raw, id }) ?? {
    id,
    filename: typeof raw.filename === "string" ? raw.filename : id,
    filesize: 0,
    duration: 0,
    start_time: 0,
    end_time: 0,
    is_trash: false,
    is_trans: false,
    is_summary: false,
  };

  const trans = extractTranscriptData(raw.trans_result ?? raw.source_list ?? raw.transcript);

  // ai_content는 JSON({"markdown": ...}) 또는 평문 마크다운 두 형태가 관찰됨
  let summary: string | undefined;
  const aiContent = raw.ai_content ?? raw.note_list ?? raw.summary;
  if (typeof aiContent === "string" && aiContent.trim().startsWith("{")) {
    try {
      const parsed = obj(JSON.parse(aiContent));
      if (typeof parsed.markdown === "string" && parsed.markdown.trim()) {
        summary = parsed.markdown.trim();
      }
    } catch {
      // extractSummary로 폴백
    }
  }
  if (!summary) summary = extractSummary(aiContent);

  return {
    ...base,
    transcript: trans.text,
    summary,
    segments: trans.segments ?? undefined,
    is_trans: base.is_trans || !!trans.text,
    is_summary: base.is_summary || !!summary,
    has_audio: true,
  };
}
