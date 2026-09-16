/**
 * Plaud 기기 원본 오디오(.opus) 처리.
 *
 * 2026-09부터 공식 API의 presigned_url이 mp3 대신 기기 원본 `oc_au_<id>.opus`를 가리킨다.
 * 이 파일은 Ogg Opus 페이지에 Plaud 메타데이터가 섞인 "혼합 컨테이너"라 Chromium(FFmpeg)이
 * 그대로는 열지 못한다. 여기서는 바이트를 훑어 Ogg 페이지("OggS")만 골라내고, OpusHead를 가진
 * 논리 스트림 하나만 남겨 표준 단일 스트림 Ogg Opus로 재조립한다 (페이지는 수정하지 않으므로 CRC 유지).
 */

const OGGS = [0x4f, 0x67, 0x67, 0x53]; // "OggS"

/** Ogg CRC32 (다항식 0x04c11db7, 비반전, 초기값 0, 최종 XOR 없음) */
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = (r & 0x80000000) !== 0 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    t[i] = r >>> 0;
  }
  return t;
})();

/** 페이지 바이트의 CRC를 계산한다 (오프셋 22~25의 CRC 필드는 0으로 취급) */
function oggCrc(b: Uint8Array, offset: number, length: number): number {
  let crc = 0;
  for (let i = 0; i < length; i++) {
    const byte = i >= 22 && i < 26 ? 0 : b[offset + i];
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

export interface AudioBytesInfo {
  bytes: number;
  head32Hex: string;
  oggPages: number;
  firstOggOffset: number;
  serials: string[];
  hasOpusHead: boolean;
  junkBytes: number;
}

interface OggPage {
  offset: number;
  length: number;
  serial: number;
  bos: boolean;
  firstPacketHead: Uint8Array;
}

function isOggS(b: Uint8Array, i: number): boolean {
  return b[i] === OGGS[0] && b[i + 1] === OGGS[1] && b[i + 2] === OGGS[2] && b[i + 3] === OGGS[3];
}

/** offset에서 Ogg 페이지 헤더를 파싱. 구조가 맞지 않으면 null */
function parsePage(b: Uint8Array, offset: number): OggPage | null {
  if (offset + 27 > b.length || !isOggS(b, offset)) return null;
  if (b[offset + 4] !== 0) return null; // stream_structure_version
  const headerType = b[offset + 5];
  const serial = (b[offset + 14] | (b[offset + 15] << 8) | (b[offset + 16] << 16) | (b[offset + 17] << 24)) >>> 0;
  const nsegs = b[offset + 26];
  const segStart = offset + 27;
  if (segStart + nsegs > b.length) return null;
  let body = 0;
  for (let i = 0; i < nsegs; i++) body += b[segStart + i];
  const length = 27 + nsegs + body;
  if (offset + length > b.length) return null;
  const bodyStart = segStart + nsegs;
  // CRC가 맞아야 진짜 페이지 — 메타데이터 블록 안의 우연한 "OggS"나 잘린 페이지를 걸러낸다
  const stored = (b[offset + 22] | (b[offset + 23] << 8) | (b[offset + 24] << 16) | (b[offset + 25] << 24)) >>> 0;
  if (oggCrc(b, offset, length) !== stored) return null;
  return {
    offset,
    length,
    serial,
    bos: (headerType & 0x02) !== 0,
    firstPacketHead: b.subarray(bodyStart, Math.min(bodyStart + 8, offset + length)),
  };
}

function scanPages(b: Uint8Array): { pages: OggPage[]; junkBytes: number } {
  const pages: OggPage[] = [];
  let junk = 0;
  let i = 0;
  while (i + 27 <= b.length) {
    if (isOggS(b, i)) {
      const p = parsePage(b, i);
      if (p) {
        pages.push(p);
        i += p.length;
        continue;
      }
    }
    junk++;
    i++;
  }
  return { pages, junkBytes: junk + Math.max(0, b.length - i) };
}

function isOpusHead(head: Uint8Array): boolean {
  // "OpusHead"
  const m = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64];
  if (head.length < 8) return false;
  for (let i = 0; i < 8; i++) if (head[i] !== m[i]) return false;
  return true;
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");
}

/** 진단용 요약 — 콘솔 로그에 남겨 포맷을 파악한다 */
export function inspectAudioBytes(data: ArrayBuffer): AudioBytesInfo {
  const b = new Uint8Array(data);
  const { pages, junkBytes } = scanPages(b);
  const serials = Array.from(new Set(pages.map((p) => p.serial))).map((s) => s.toString(16));
  return {
    bytes: b.length,
    head32Hex: hex(b.subarray(0, 32)),
    oggPages: pages.length,
    firstOggOffset: pages.length ? pages[0].offset : -1,
    serials,
    hasOpusHead: pages.some((p) => p.bos && isOpusHead(p.firstPacketHead)),
    junkBytes,
  };
}

export interface ExtractResult {
  ogg: ArrayBuffer;
  keptPages: number;
  droppedPages: number;
  junkBytes: number;
  /** 입력이 이미 깨끗한 단일 스트림 Ogg였는지 (그렇다면 재조립이 불필요했음) */
  alreadyClean: boolean;
}

/**
 * OpusHead 스트림의 Ogg 페이지만 이어붙인 표준 Ogg Opus를 만든다.
 * Ogg 페이지가 없거나 OpusHead 스트림이 없으면 null.
 */
export function extractOggOpus(data: ArrayBuffer): ExtractResult | null {
  const b = new Uint8Array(data);
  const { pages, junkBytes } = scanPages(b);
  if (!pages.length) return null;
  const head = pages.find((p) => p.bos && isOpusHead(p.firstPacketHead));
  if (!head) return null;
  const kept = pages.filter((p) => p.serial === head.serial);
  const total = kept.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of kept) {
    out.set(b.subarray(p.offset, p.offset + p.length), pos);
    pos += p.length;
  }
  return {
    ogg: out.buffer,
    keptPages: kept.length,
    droppedPages: pages.length - kept.length,
    junkBytes,
    alreadyClean: junkBytes === 0 && pages.length === kept.length && pages[0].offset === 0,
  };
}
