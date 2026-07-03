/**
 * (구) Plaud region 라벨. MCP 전환 후에는 단일 엔드포인트라 사실상 미사용이지만,
 * import 템플릿 변수 {{region}} 호환을 위해 문자열 별칭으로 유지한다.
 */
export type PlaudRegion = string;

/**
 * Plaud 공식 개발자 API (Dev API). 공식 MCP/CLI(@plaud-ai/mcp, @plaud-ai/cli)가
 * 사용하는 것과 동일한 OAuth + REST 표면이다.
 * mcp.plaud.ai JSON-RPC 경유(v0.4~0.5)는 refresh token 수명이 짧아 며칠마다
 * 재로그인이 필요했으므로 v0.6.0에서 이 경로로 전환했다.
 */
export const PLAUD_DEV_API_BASE = "https://platform.plaud.ai/developer/api";
export const PLAUD_AUTHORIZE_URL = "https://web.plaud.ai/platform/oauth";
export const PLAUD_TOKEN_URL = `${PLAUD_DEV_API_BASE}/oauth/third-party/access-token`;
export const PLAUD_REFRESH_URL = `${PLAUD_TOKEN_URL}/refresh`;
/** 공식 배포 패키지에 내장된 public client (secret 없음) */
export const PLAUD_CLIENT_ID = "client_9c501dad-8a0d-40b2-a7b0-d1cb8787f674";
/** 공식 client에 등록된 유일한 redirect — loopback 콜백 서버 포트 고정 */
export const PLAUD_CALLBACK_PORT = 8199;
export const PLAUD_REDIRECT_URI = `http://localhost:${PLAUD_CALLBACK_PORT}/auth/callback`;

/**
 * OAuth 토큰 번들. Dev API access-token 응답 기반.
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

/** 전사 세그먼트 (서버 실측 구조) */
export interface PlaudTranscriptSegment {
  content: string;
  /** ms */
  start_time: number;
  /** ms */
  end_time: number;
  speaker?: string;
}

export interface PlaudRecordingDetail extends PlaudRecording {
  transcript: string;
  summary?: string;
  /** 타임스탬프 점프용 원본 세그먼트 (없으면 평문 전사만) */
  segments?: PlaudTranscriptSegment[];
  /** 오디오(presigned URL) 존재 여부 — 상세 응답 실측 */
  has_audio?: boolean;
}

/** 사이드패널 기간 필터 */
export type DateRangeFilter = "all" | "today" | "7d" | "30d";

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
  /** 임포트 시 성경 구절 자동 wikilink 변환 */
  autoBibleWikilink: boolean;
  /** 전사 없는 녹음 임포트 시 외부 STT 자동 실행 */
  autoSttOnImport: boolean;
  /** 오디오 저장 폴더 (빈 문자열이면 "{importFolder}/audio") */
  audioFolder: string;
  /** 새 녹음 자동 감지 주기(분). 0 = 끔 */
  autoCheckMinutes: number;
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
  autoBibleWikilink: true,
  autoSttOnImport: false,
  audioFolder: "",
  autoCheckMinutes: 0,
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
