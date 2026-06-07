import { requestUrl } from "obsidian";
import {
  PlaudRecording,
  PlaudRecordingDetail,
  PlaudRegion,
  PlaudTokenData,
  PlaudUserInfo,
  plaudBaseUrl,
  plaudRegionFromDomain,
} from "./types";

export type PlaudApiErrorCode =
  | "UNAUTHORIZED"
  | "NETWORK"
  | "REGION_MISMATCH"
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

interface RequestResult {
  data: Record<string, unknown>;
  regionUsed: PlaudRegion;
}

export async function plaudRequest(
  path: string,
  token: PlaudTokenData,
  options: { method?: string; body?: string } = {}
): Promise<RequestResult> {
  let region = token.region;
  const triedRegions = new Set<PlaudRegion>();
  for (let attempt = 0; attempt < 3; attempt++) {
    triedRegions.add(region);
    const baseUrl = plaudBaseUrl(region);
    let res;
    try {
      res = await requestUrl({
        url: `${baseUrl}${path}`,
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          "Content-Type": "application/json",
          // web 클라이언트가 보내는 헤더 — 쓰기 엔드포인트가 일부를 요구할 수 있음
          "app-platform": "web",
          "app-language": "en",
          "edit-from": "web",
        },
        body: options.body,
        throw: false,
      });
    } catch {
      throw new PlaudApiError("NETWORK", "Plaud 서버에 연결할 수 없습니다.");
    }

    if (res.status === 401) {
      throw new PlaudApiError(
        "UNAUTHORIZED",
        "Plaud 인증이 만료되었거나 유효하지 않습니다. 새 토큰을 입력해 주세요.",
        401
      );
    }

    const data = (res.json ?? {}) as Record<string, unknown> & {
      status?: number;
      data?: { domains?: { api?: string } };
    };

    if (data.status === -302 && data.data?.domains?.api) {
      const rawDomain = data.data.domains.api;
      const nextRegion = plaudRegionFromDomain(rawDomain);
      console.log("[A4P Plaud] -302 redirect", {
        path,
        currentRegion: region,
        rawDomain,
        parsedRegion: nextRegion,
        triedRegions: Array.from(triedRegions),
        fullDomains: data.data?.domains,
      });
      if (!triedRegions.has(nextRegion)) {
        region = nextRegion;
        continue;
      }
      throw new PlaudApiError(
        "REGION_MISMATCH",
        `Plaud 리전을 확인할 수 없습니다. (domain=${rawDomain}, parsed=${nextRegion}). 콘솔 로그를 확인해 주세요.`
      );
    }

    if (data.status !== undefined && data.status !== 0 && data.status !== -302) {
      console.warn("[A4P Plaud] non-zero status", { path, region, data });
    }

    return { data, regionUsed: region };
  }
  throw new PlaudApiError("UNKNOWN", "Plaud API 호출 실패");
}

export async function getUserInfo(
  token: PlaudTokenData
): Promise<{ user: PlaudUserInfo; region: PlaudRegion }> {
  const { data, regionUsed } = await plaudRequest("/user/me", token);
  const user =
    (data.data_user as Record<string, unknown> | undefined) ??
    (data.data as Record<string, unknown> | undefined) ??
    (data as Record<string, unknown>);
  const state = data.data_state as Record<string, unknown> | undefined;
  const membership = (state?.membership_type as string | undefined) ?? "unknown";
  return {
    user: {
      id: String(user?.id ?? ""),
      nickname: String(user?.nickname ?? ""),
      email: String(user?.email ?? ""),
      country: String(user?.country ?? ""),
      membership_type: membership,
    },
    region: regionUsed,
  };
}

function normalizeRecording(raw: Record<string, unknown>): PlaudRecording | null {
  const id = (raw.file_id ?? raw.id) as string | undefined;
  if (!id) return null;
  return {
    id,
    filename: String(raw.file_name ?? raw.filename ?? id),
    fullname: raw.fullname as string | undefined,
    filesize: Number(raw.file_size ?? raw.filesize ?? 0),
    duration: Number(raw.duration ?? 0),
    start_time: Number(raw.start_time ?? 0),
    end_time: Number(raw.end_time ?? 0),
    is_trash: Boolean(raw.is_trash),
    is_trans: Boolean(raw.is_trans),
    is_summary: Boolean(raw.is_summary),
    keywords: Array.isArray(raw.keywords) ? (raw.keywords as string[]) : undefined,
    serial_number: raw.serial_number as string | undefined,
  };
}

export async function listRecordings(token: PlaudTokenData): Promise<PlaudRecording[]> {
  const { data } = await plaudRequest("/file/simple/web", token);
  const rawList =
    (data.data_file_list as Record<string, unknown>[] | undefined) ??
    (data.data as Record<string, unknown>[] | undefined) ??
    [];
  const recordings: PlaudRecording[] = [];
  for (const raw of rawList) {
    const rec = normalizeRecording(raw);
    if (rec && !rec.is_trash) recordings.push(rec);
  }
  return recordings;
}

export async function getRecordingDetail(
  token: PlaudTokenData,
  id: string
): Promise<PlaudRecordingDetail> {
  const { data } = await plaudRequest(`/file/detail/${encodeURIComponent(id)}`, token);
  const raw = ((data.data as Record<string, unknown> | undefined) ?? data) as Record<string, unknown>;
  const base = normalizeRecording(raw) ?? {
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
  const preDownload = raw.pre_download_content_list as
    | Array<{ data_content?: string }>
    | undefined;
  if (Array.isArray(preDownload)) {
    for (const item of preDownload) {
      const content = item?.data_content ?? "";
      if (typeof content === "string" && content.length > transcript.length) {
        transcript = content;
      }
    }
  }

  const summary =
    (raw.summary as string | undefined) ??
    (raw.ai_summary as string | undefined) ??
    undefined;

  return { ...base, transcript, summary };
}

/**
 * Plaud 서버의 녹음 이름을 변경한다.
 * PATCH /file/{id}  body: { file_name: "..." }
 * (web 클라이언트가 사용하는 엔드포인트를 따름. body 키는 file_name으로 추정.)
 *
 * 호환 시도 순서: file_name → filename → name
 * 200/0 외 응답은 콘솔에 자세히 로깅한다.
 */
export async function renameRecording(
  token: PlaudTokenData,
  id: string,
  newName: string
): Promise<void> {
  const candidates = [
    { file_name: newName },
    { filename: newName },
    { name: newName },
  ];
  let lastErr: unknown = null;
  for (const body of candidates) {
    try {
      const { data } = await plaudRequest(`/file/${encodeURIComponent(id)}`, token, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      // status 필드 검사 — 0이면 성공, 다른 값이면 다른 키 시도
      const apiStatus = (data as Record<string, unknown>).status;
      if (apiStatus === undefined || apiStatus === 0) {
        console.log("[A4P Plaud] rename 성공", { id, body, response: data });
        return;
      }
      console.warn("[A4P Plaud] rename 응답 비정상 status", { id, body, response: data });
      lastErr = new PlaudApiError(
        "BAD_RESPONSE",
        `Plaud 응답 status=${apiStatus} msg=${(data as Record<string, unknown>).msg ?? "(없음)"}`
      );
    } catch (e) {
      console.warn("[A4P Plaud] rename 시도 실패", { id, body, error: e });
      lastErr = e;
    }
  }
  if (lastErr instanceof Error) throw lastErr;
  throw new PlaudApiError("UNKNOWN", "rename 실패 (모든 body 키 시도)");
}

export async function getMp3Url(
  token: PlaudTokenData,
  id: string
): Promise<string | null> {
  try {
    const { data } = await plaudRequest(
      `/file/temp-url/${encodeURIComponent(id)}?is_opus=false`,
      token
    );
    const candidate =
      (data.url as string | undefined) ??
      ((data.data as Record<string, unknown> | undefined)?.url as string | undefined) ??
      (typeof data.data === "string" ? (data.data as string) : undefined) ??
      (data.temp_url as string | undefined);
    return candidate ?? null;
  } catch {
    return null;
  }
}
