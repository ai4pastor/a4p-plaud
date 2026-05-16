/**
 * Plaud의 region 라벨. 알려진 값: "us", "eu", "apne1" 등.
 * 서버의 -302 응답에서 새 도메인이 오면 동적으로 추가될 수 있어 string으로 둔다.
 */
export type PlaudRegion = string;

export function plaudBaseUrl(region: PlaudRegion): string {
  if (region === "us") return "https://api.plaud.ai";
  if (region === "eu") return "https://api-euc1.plaud.ai";
  return `https://api-${region}.plaud.ai`;
}

/**
 * 도메인 문자열에서 region 라벨을 추출한다. 풀 URL("https://api-apne1.plaud.ai")과
 * 호스트만("api-apne1.plaud.ai") 모두 지원.
 *   "api-apne1.plaud.ai" → "apne1"
 *   "api-euc1.plaud.ai"  → "eu"  (별칭 통일)
 *   "api.plaud.ai"       → "us"
 */
export function plaudRegionFromDomain(domain: string): PlaudRegion {
  let host = domain;
  try {
    host = new URL(domain).hostname;
  } catch {
    // 풀 URL이 아닌 경우 그대로 사용
  }
  const m = host.match(/^api(?:-([^.]+))?\./);
  if (!m) return "us";
  const label = m[1];
  if (!label) return "us";
  if (label === "euc1") return "eu";
  return label;
}

export interface PlaudTokenData {
  accessToken: string;
  tokenType: string;
  issuedAt: number;
  expiresAt: number;
  region: PlaudRegion;
}

export interface PlaudUserInfo {
  id: string;
  nickname: string;
  email: string;
  country: string;
  membership_type: string;
}

export interface PlaudRecording {
  id: string;
  filename: string;
  fullname?: string;
  filesize: number;
  duration: number;
  start_time: number;
  end_time: number;
  is_trash: boolean;
  is_trans: boolean;
  is_summary: boolean;
  keywords?: string[];
  serial_number?: string;
}

export interface PlaudRecordingDetail extends PlaudRecording {
  transcript: string;
  summary?: string;
}

export interface PlaudSettings {
  encryptedToken: string | null;
}

export const DEFAULT_SETTINGS: PlaudSettings = {
  encryptedToken: null,
};
