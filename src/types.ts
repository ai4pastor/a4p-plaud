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

export type SttProvider = "groq" | "openai";

export interface PlaudSettings {
  encryptedToken: string | null;
  importFolder: string;
  /** 기본 임포트 템플릿 (.md 파일의 vault 내 경로). 빈 문자열이면 내장 형식 사용. */
  templatePath: string;
  /** 외부 STT 디폴트 공급자 */
  sttProvider: SttProvider;
  /** 공급자별 암호화 API 키 */
  encryptedGroqKey: string | null;
  encryptedOpenaiKey: string | null;
  /** 모델 (빈 값이면 공급자별 기본 모델) */
  sttGroqModel: string;
  sttOpenaiModel: string;
  /** 언어 hint ("" = 자동, "ko" = 한국어, "en" = 영어 등 ISO 639-1) */
  sttLanguage: string;
  /** 디폴트 공급자 실패 시 자동으로 다른 공급자 시도 */
  sttAutoFallback: boolean;
}

export const DEFAULT_SETTINGS: PlaudSettings = {
  encryptedToken: null,
  importFolder: "Plaud",
  templatePath: "",
  sttProvider: "groq",
  encryptedGroqKey: null,
  encryptedOpenaiKey: null,
  sttGroqModel: "whisper-large-v3-turbo",
  sttOpenaiModel: "whisper-1",
  sttLanguage: "ko",
  sttAutoFallback: false,
};

/** 공급자별 최대 파일 크기 (바이트) */
export const STT_MAX_FILE_SIZE: Record<SttProvider, number> = {
  groq: 500 * 1024 * 1024, // 500MB
  openai: 25 * 1024 * 1024, // 25MB
};

/** 공급자별 분당 예상 비용 (USD) — 사전 안내용 */
export const STT_COST_PER_HOUR: Record<SttProvider, number> = {
  groq: 0.04,
  openai: 0.36,
};

export interface SttResult {
  text: string;
  provider: SttProvider;
  model: string;
  language?: string;
  /** 전사 완료 시각 (epoch ms) */
  at: number;
}
