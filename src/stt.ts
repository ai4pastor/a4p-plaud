import { requestUrl } from "obsidian";
import {
  STT_MAX_FILE_SIZE,
  SttProvider,
  SttResult,
} from "./types";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const OPENAI_URL = "https://api.openai.com/v1/audio/transcriptions";

export type SttErrorCode =
  | "MISSING_KEY"
  | "FILE_TOO_LARGE"
  | "DOWNLOAD_FAILED"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "SERVER"
  | "NETWORK"
  | "UNKNOWN";

export class SttError extends Error {
  constructor(public code: SttErrorCode, message: string) {
    super(message);
    this.name = "SttError";
  }
}

export interface ProgressCallback {
  (stage: "download" | "upload" | "done", info?: { bytes?: number; total?: number }): void;
}

function headerOf(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return undefined;
}

/** 오디오 전체 수신 — Node 측(requestUrl)이라 브라우저 미디어 로더의 제약(헤더·CORS·Content-Type)을 받지 않는다. */
export async function downloadAudio(
  url: string,
  onProgress?: ProgressCallback
): Promise<{ data: ArrayBuffer; contentType: string }> {
  onProgress?.("download");
  try {
    const res = await requestUrl({ url, method: "GET", throw: false });
    if (res.status >= 400) {
      throw new SttError("DOWNLOAD_FAILED", `mp3 다운로드 실패 (HTTP ${res.status})`);
    }
    return { data: res.arrayBuffer, contentType: (headerOf(res.headers, "content-type") ?? "").toLowerCase() };
  } catch (e) {
    if (e instanceof SttError) throw e;
    throw new SttError("DOWNLOAD_FAILED", "mp3 다운로드 중 네트워크 오류가 발생했습니다.");
  }
}

export async function downloadMp3(url: string, onProgress?: ProgressCallback): Promise<ArrayBuffer> {
  return (await downloadAudio(url, onProgress)).data;
}

export interface AudioProbe {
  status: number;
  /** 소문자 content-type (없으면 "") */
  contentType: string;
  /** 전체 길이(bytes) — Content-Range 또는 Content-Length. 모르면 null */
  contentLength: number | null;
  /** 서버가 Range를 무시하고 전체를 보냈으면 그 본문 (재다운로드 방지) */
  fullBody?: ArrayBuffer;
  /** 파일 머리(최대 64바이트) — 컨테이너 판별용 */
  head: Uint8Array;
}

/** 파일 머리로 컨테이너 판별 */
export function sniffAudioHead(head: Uint8Array): "ogg" | "plaud-encrypted" | "mp3" | "unknown" {
  const ascii = (n: number) => String.fromCharCode(...Array.from(head.subarray(0, n)));
  if (head.length >= 4 && ascii(4) === "OggS") return "ogg";
  if (head.length >= 8 && ascii(8) === "PLAUD.AI") return "plaud-encrypted";
  if (head.length >= 3 && (ascii(3) === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0))) return "mp3";
  return "unknown";
}

/**
 * 오디오 URL이 살아 있는지 Node 측으로 확인 — HTTP 상태·Content-Type·길이를 회수한다.
 * <audio>가 "no supported source"로 실패했을 때 서버 거부(4xx)인지 형식 문제인지 가르는 용도.
 * 네트워크 자체가 안 되면 null. 절대 throw하지 않는다.
 */
export async function probeAudioUrl(url: string): Promise<AudioProbe | null> {
  try {
    const res = await requestUrl({
      url,
      method: "GET",
      headers: { Range: "bytes=0-63" },
      throw: false,
    });
    const range = headerOf(res.headers, "content-range");
    const lenRaw = range?.split("/")[1] ?? headerOf(res.headers, "content-length");
    const contentLength = lenRaw && !isNaN(Number(lenRaw)) ? Number(lenRaw) : null;
    const probe: AudioProbe = {
      status: res.status,
      contentType: (headerOf(res.headers, "content-type") ?? "").toLowerCase(),
      contentLength: res.status === 206 ? contentLength : res.status === 200 ? res.arrayBuffer.byteLength : contentLength,
      head: new Uint8Array(res.arrayBuffer).subarray(0, 64),
    };
    if (res.status === 200 && res.arrayBuffer.byteLength > 64) probe.fullBody = res.arrayBuffer;
    return probe;
  } catch (e) {
    console.warn("[A4P Plaud] probeAudioUrl 네트워크 오류", e);
    return null;
  }
}

/** URL 경로 확장자로 MIME 추정 — Blob 재생 시 서버 content-type이 비어 있을 때 사용 */
export function guessAudioMime(url: string): string | null {
  let ext = "";
  try {
    ext = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
  } catch {
    return null;
  }
  const table: Record<string, string> = {
    mp3: "audio/mpeg",
    opus: "audio/ogg",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    aac: "audio/aac",
    wav: "audio/wav",
    webm: "audio/webm",
    flac: "audio/flac",
  };
  return table[ext] ?? null;
}

interface MultipartField {
  name: string;
  value: string;
}

/**
 * multipart/form-data body를 직접 구성한다 (Obsidian requestUrl이 form data를 지원하지 않으므로).
 */
function buildMultipart(
  audio: ArrayBuffer,
  filename: string,
  fields: MultipartField[]
): { body: ArrayBuffer; contentType: string } {
  const boundary = `----A4PPlaudBoundary${Math.random().toString(16).slice(2)}`;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];

  // 필드들
  for (const f of fields) {
    parts.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`
      )
    );
  }

  // 파일 헤더
  parts.push(
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/mpeg\r\n\r\n`
    )
  );
  // 파일 바이너리
  parts.push(new Uint8Array(audio));
  // 끝
  parts.push(enc.encode(`\r\n--${boundary}--\r\n`));

  // 합치기
  const total = parts.reduce((s, p) => s + p.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    buf.set(p, offset);
    offset += p.length;
  }
  return { body: buf.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}

function decodeError(provider: SttProvider, status: number): SttError {
  if (status === 401 || status === 403) {
    return new SttError("UNAUTHORIZED", `${provider} API 키가 잘못되었거나 만료되었습니다.`);
  }
  if (status === 413) {
    return new SttError("FILE_TOO_LARGE", `${provider}: 파일이 너무 큽니다.`);
  }
  if (status === 429) {
    return new SttError("RATE_LIMITED", `${provider}: 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.`);
  }
  if (status >= 500) {
    return new SttError("SERVER", `${provider}: 서버 일시 장애 (HTTP ${status}). 다시 시도해 주세요.`);
  }
  return new SttError("UNKNOWN", `${provider}: 알 수 없는 오류 (HTTP ${status}).`);
}

interface CallOptions {
  apiKey: string;
  audio: ArrayBuffer;
  filename?: string;
  model: string;
  language?: string;
  onProgress?: ProgressCallback;
}

async function callWhisperApi(
  url: string,
  provider: SttProvider,
  opts: CallOptions
): Promise<string> {
  if (!opts.apiKey) {
    throw new SttError("MISSING_KEY", `${provider} API 키가 설정되어 있지 않습니다.`);
  }
  const max = STT_MAX_FILE_SIZE[provider];
  if (opts.audio.byteLength > max) {
    throw new SttError(
      "FILE_TOO_LARGE",
      `파일이 ${(opts.audio.byteLength / 1024 / 1024).toFixed(1)} MB로 ${provider} 제한(${(max / 1024 / 1024).toFixed(0)} MB)을 초과합니다.`
    );
  }

  const fields: MultipartField[] = [
    { name: "model", value: opts.model },
    { name: "response_format", value: "json" },
  ];
  if (opts.language) fields.push({ name: "language", value: opts.language });

  const { body, contentType } = buildMultipart(
    opts.audio,
    opts.filename ?? "audio.mp3",
    fields
  );

  opts.onProgress?.("upload", { total: body.byteLength });

  let res;
  try {
    res = await requestUrl({
      url,
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": contentType,
      },
      body,
      throw: false,
    });
  } catch {
    throw new SttError("NETWORK", `${provider} 서버에 연결할 수 없습니다.`);
  }

  if (res.status >= 400) {
    throw decodeError(provider, res.status);
  }

  const data = (res.json ?? {}) as { text?: string };
  if (typeof data.text !== "string") {
    throw new SttError("UNKNOWN", `${provider}: 예상 외 응답 형식.`);
  }
  opts.onProgress?.("done");
  return data.text;
}

export interface TranscribeArgs {
  provider: SttProvider;
  groqKey?: string | null;
  openaiKey?: string | null;
  groqModel: string;
  openaiModel: string;
  language: string;
  audio: ArrayBuffer;
  filename?: string;
  /** 디폴트 공급자 실패 시 다른 공급자로 자동 재시도 */
  autoFallback: boolean;
  onProgress?: ProgressCallback;
}

async function callProvider(
  provider: SttProvider,
  args: TranscribeArgs
): Promise<{ text: string; model: string }> {
  if (provider === "groq") {
    const model = args.groqModel || "whisper-large-v3-turbo";
    const text = await callWhisperApi(GROQ_URL, "groq", {
      apiKey: args.groqKey ?? "",
      audio: args.audio,
      filename: args.filename,
      model,
      language: args.language || undefined,
      onProgress: args.onProgress,
    });
    return { text, model };
  }
  const model = args.openaiModel || "whisper-1";
  const text = await callWhisperApi(OPENAI_URL, "openai", {
    apiKey: args.openaiKey ?? "",
    audio: args.audio,
    filename: args.filename,
    model,
    language: args.language || undefined,
    onProgress: args.onProgress,
  });
  return { text, model };
}

export async function transcribeAudio(args: TranscribeArgs): Promise<SttResult> {
  const primary = args.provider;
  try {
    const { text, model } = await callProvider(primary, args);
    return {
      text,
      provider: primary,
      model,
      language: args.language || undefined,
      at: Date.now(),
    };
  } catch (e) {
    if (!args.autoFallback || !(e instanceof SttError)) throw e;
    if (e.code !== "UNAUTHORIZED" && e.code !== "RATE_LIMITED" && e.code !== "SERVER" && e.code !== "NETWORK") {
      throw e; // FILE_TOO_LARGE 등은 폴백해도 의미 없음
    }
    const other: SttProvider = primary === "groq" ? "openai" : "groq";
    try {
      const { text, model } = await callProvider(other, args);
      return {
        text,
        provider: other,
        model,
        language: args.language || undefined,
        at: Date.now(),
      };
    } catch {
      throw e; // 폴백도 실패하면 원래 에러
    }
  }
}
