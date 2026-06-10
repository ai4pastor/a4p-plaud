/**
 * (구) Plaud region 라벨. MCP 전환 후에는 단일 엔드포인트라 사실상 미사용이지만,
 * import 템플릿 변수 {{region}} 호환을 위해 문자열 별칭으로 유지한다.
 */
export type PlaudRegion = string;

/** 공식 MCP 서버 (OAuth + JSON-RPC) */
export const PLAUD_MCP_BASE = "https://mcp.plaud.ai";
export const PLAUD_MCP_ENDPOINT = `${PLAUD_MCP_BASE}/mcp`;
/** OAuth redirect — Obsidian 커스텀 프로토콜 핸들러 */
export const PLAUD_OAUTH_PROTOCOL = "a4p-plaud-oauth";
export const PLAUD_OAUTH_REDIRECT = `obsidian://${PLAUD_OAUTH_PROTOCOL}`;

/**
 * OAuth 2.1 토큰 번들. mcp.plaud.ai/token 응답 + 동적 등록 client_id.
 * 만료 시 refreshToken으로 자동 재발급한다.
 */
export interface PlaudTokenData {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  /** access token 만료 시각 (epoch ms) */
  expiresAt: number;
  tokenType: string;
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
  /** safeStorage로 암호화한 PlaudTokenData(OAuth 번들) JSON */
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
