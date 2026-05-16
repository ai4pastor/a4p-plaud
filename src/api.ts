import { requestUrl } from "obsidian";
import {
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
