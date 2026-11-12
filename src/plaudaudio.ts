/**
 * Plaud 기기 원본 오디오(.opus) 처리.
 *
 * 2026-09부터 공식 API의 presigned_url이 (서버 mp3 변환본이 생기기 전까지) 기기 원본
 * `oc_au_<id>.opus`를 가리킨다. Chromium(FFmpeg)은 이 원본을 그대로 열지 못한다. 확인된 형태는 셋이다.
 * - 혼합 컨테이너(2026-09): Ogg Opus 페이지에 Plaud 메타데이터가 섞여 있다 → Ogg 페이지("OggS")만 골라
 *   OpusHead를 가진 논리 스트림 하나로 재조립한다 (페이지는 수정하지 않으므로 CRC 유지).
 * - 날 패킷 스트림(2026-11): 컨테이너 없이 고정 길이 Opus 패킷만 이어 붙였다
 *   (예: 80바이트 = 20ms·16kHz 모노 CELT, TOC 0xb8) → 패킷 길이를 찾아 표준 Ogg Opus(RFC 7845)로 포장한다.
 * - 암호화 컨테이너("PLAUD.AI" 머리): 풀 수 없다 → 호출자가 웹 API mp3 변환본으로 폴백한다.
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

// ─────────────────────────────────────────── 날 Opus 패킷 스트림 → Ogg Opus

/** Opus 패킷 최대 길이 (RFC 6716 3.4) */
const OPUS_MAX_PACKET_BYTES = 1275;
/** 패킷이 이보다 적으면 날 스트림으로 판정하지 않는다 — 우연한 일치 방지 (20ms 패킷이면 1초) */
const RAW_OPUS_MIN_PACKETS = 50;
/** 데이터 페이지 하나에 담을 길이 (48kHz 샘플 = 약 1초) */
const PAGE_TARGET_SAMPLES = 48000;
const WRAP_SERIAL = 0x41345044;
const WRAP_VENDOR = "a4p-plaud";

export interface RawOpusInfo {
  /** 패킷 하나의 바이트 수 (모든 패킷 동일) */
  packetSize: number;
  packets: number;
  /** 끝에 남은 불완전 패킷 바이트 (버린다) */
  trailingBytes: number;
  channels: 1 | 2;
  /** 패킷 하나가 담는 길이 (48kHz 샘플 수) */
  samplesPerPacket: number;
  /** 원래 대역의 샘플레이트 — OpusHead 정보용 */
  inputSampleRate: number;
  seconds: number;
}

/** TOC config(0~31)의 프레임 길이 — 48kHz 샘플 수 (RFC 6716 3.1) */
function opusFrameSamples(config: number): number {
  if (config < 12) return [480, 960, 1920, 2880][config & 3]; // SILK 10/20/40/60ms
  if (config < 16) return [480, 960][config & 1]; // Hybrid 10/20ms
  return [120, 240, 480, 960][config & 3]; // CELT 2.5/5/10/20ms
}

/** TOC config의 오디오 대역 → 샘플레이트 */
function opusBandwidthRate(config: number): number {
  if (config < 4) return 8000; // SILK NB
  if (config < 8) return 12000; // SILK MB
  if (config < 12) return 16000; // SILK WB
  if (config < 14) return 24000; // Hybrid SWB
  if (config < 16) return 48000; // Hybrid FB
  return [8000, 16000, 24000, 48000][(config - 16) >> 2]; // CELT NB/WB/SWB/FB
}

/** 패킷 하나의 길이(48kHz 샘플). code 3은 둘째 바이트의 프레임 수를 쓴다. 규격 밖(0프레임·120ms 초과)이면 0 */
function opusPacketSamples(toc: number, countByte: number): number {
  const code = toc & 0x03;
  const frames = code === 0 ? 1 : code === 3 ? countByte & 0x3f : 2;
  const total = frames * opusFrameSamples(toc >> 3);
  return frames > 0 && total <= 5760 ? total : 0;
}

/**
 * 컨테이너 없는 고정 길이 Opus 패킷 스트림인지 판정한다.
 * 고정 비트레이트 녹음은 패킷마다 TOC 바이트가 같으므로, 모든 패킷이 첫 패킷과 같은 TOC로 시작하는
 * 가장 작은 패킷 길이를 찾는다. 해당 없으면 null.
 */
export function detectRawOpus(data: ArrayBuffer): RawOpusInfo | null {
  const b = new Uint8Array(data);
  if (b.length < 2) return null;
  const toc = b[0];
  const samplesPerPacket = opusPacketSamples(toc, b[1]);
  if (!samplesPerPacket) return null;
  const code3 = (toc & 0x03) === 3;
  for (let size = 2; size <= OPUS_MAX_PACKET_BYTES; size++) {
    const packets = Math.floor(b.length / size);
    if (packets < RAW_OPUS_MIN_PACKETS) break; // 길이가 커질수록 패킷 수는 줄어든다
    let same = true;
    for (let i = size; i + size <= b.length; i += size) {
      if (b[i] !== toc || (code3 && b[i + 1] !== b[1])) {
        same = false;
        break;
      }
    }
    if (!same) continue;
    return {
      packetSize: size,
      packets,
      trailingBytes: b.length - packets * size,
      channels: toc & 0x04 ? 2 : 1,
      samplesPerPacket,
      inputSampleRate: opusBandwidthRate(toc >> 3),
      seconds: (packets * samplesPerPacket) / 48000,
    };
  }
  return null;
}

/** Ogg 페이지 한 장을 만든다 (CRC 포함). granule은 ES2018 대상이라 BigInt 없이 32비트 두 번으로 쓴다 */
function buildOggPage(packets: Uint8Array[], granule: number, seq: number, flags: number): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  const bodyLength = packets.reduce((s, p) => s + p.length, 0);
  const page = new Uint8Array(27 + lacing.length + bodyLength);
  const dv = new DataView(page.buffer);
  page.set(OGGS, 0);
  page[5] = flags;
  dv.setUint32(6, granule % 0x100000000, true);
  dv.setUint32(10, Math.floor(granule / 0x100000000), true);
  dv.setUint32(14, WRAP_SERIAL, true);
  dv.setUint32(18, seq, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let pos = 27 + lacing.length;
  for (const p of packets) {
    page.set(p, pos);
    pos += p.length;
  }
  // CRC 필드(22~25)가 0인 채로 계산한 뒤 채운다
  dv.setUint32(22, oggCrc(page, 0, page.length), true);
  return page;
}

/** 날 Opus 패킷 스트림을 표준 Ogg Opus(RFC 7845)로 포장한다. 날 스트림이 아니면 null */
export function wrapRawOpus(data: ArrayBuffer, info: RawOpusInfo | null = detectRawOpus(data)): ArrayBuffer | null {
  if (!info) return null;
  const b = new Uint8Array(data);
  const enc = new TextEncoder();

  const head = new Uint8Array(19);
  const hv = new DataView(head.buffer);
  head.set(enc.encode("OpusHead"), 0);
  head[8] = 1; // version
  head[9] = info.channels;
  hv.setUint16(10, 0, true); // pre-skip — 기기 인코더 지연을 알 수 없어 0 (전사 타임스탬프와 그대로 맞는다)
  hv.setUint32(12, info.inputSampleRate, true);
  // output gain 0, channel mapping family 0 (모노/스테레오)

  const vendor = enc.encode(WRAP_VENDOR);
  const tags = new Uint8Array(16 + vendor.length);
  const tv = new DataView(tags.buffer);
  tags.set(enc.encode("OpusTags"), 0);
  tv.setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  // 사용자 comment 0개 (마지막 4바이트 0)

  const pages: Uint8Array[] = [buildOggPage([head], 0, 0, 0x02), buildOggPage([tags], 0, 1, 0)];
  const lacingPerPacket = Math.floor(info.packetSize / 255) + 1;
  const perPage = Math.max(
    1,
    Math.min(Math.floor(255 / lacingPerPacket), Math.floor(PAGE_TARGET_SAMPLES / info.samplesPerPacket))
  );
  let granule = 0;
  for (let i = 0, seq = 2; i < info.packets; i += perPage, seq++) {
    const n = Math.min(perPage, info.packets - i);
    const group: Uint8Array[] = [];
    for (let k = 0; k < n; k++) {
      const offset = (i + k) * info.packetSize;
      group.push(b.subarray(offset, offset + info.packetSize));
    }
    granule += n * info.samplesPerPacket;
    pages.push(buildOggPage(group, granule, seq, i + n >= info.packets ? 0x04 : 0));
  }

  const out = new Uint8Array(pages.reduce((s, p) => s + p.length, 0));
  let pos = 0;
  for (const p of pages) {
    out.set(p, pos);
    pos += p.length;
  }
  return out.buffer;
}

// ─────────────────────────────────────────── 형식 판별 · 통합 변환

/** 파일 머리로 컨테이너 판별 */
export function sniffAudioHead(head: Uint8Array): "ogg" | "plaud-encrypted" | "mp3" | "unknown" {
  const ascii = (n: number) => String.fromCharCode(...Array.from(head.subarray(0, n)));
  if (head.length >= 4 && ascii(4) === "OggS") return "ogg";
  if (head.length >= 8 && ascii(8) === "PLAUD.AI") return "plaud-encrypted";
  if (head.length >= 3 && (ascii(3) === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0))) return "mp3";
  return "unknown";
}

/** 기기 원본 오디오 URL인지 — 경로가 .opus로 끝나면(oc_au_….opus) 브라우저가 스트리밍으로 열 수 없다 */
export function isDeviceOriginalUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".opus");
  } catch {
    return false;
  }
}

export interface PlayableAudio {
  data: ArrayBuffer;
  /** mp3·ogg = 그대로 · ogg-extracted = 혼합 컨테이너 재조립 · ogg-wrapped = 날 패킷 포장 · encrypted/unknown = 변환 못 함 */
  kind: "mp3" | "ogg" | "ogg-extracted" | "ogg-wrapped" | "encrypted" | "unknown";
  /** 재생·업로드 MIME (변환 못 했으면 "") */
  mime: string;
  /** 저장·업로드 확장자 (변환 못 했으면 "") */
  ext: string;
  /** 날 스트림을 포장했으면 판정 정보 (진단 로그용) */
  raw?: RawOpusInfo;
}

/**
 * Plaud가 준 오디오 바이트를 브라우저·STT가 읽을 수 있는 형태로 맞춘다.
 * mp3·표준 Ogg는 그대로, 혼합 컨테이너는 재조립, 날 패킷 스트림은 Ogg로 포장한다.
 * 암호화 컨테이너나 모르는 형식은 원본 그대로 돌려준다 (호출자가 웹 mp3 변환본 등으로 폴백).
 */
export function toPlayableAudio(data: ArrayBuffer): PlayableAudio {
  const head = sniffAudioHead(new Uint8Array(data, 0, Math.min(64, data.byteLength)));
  if (head === "mp3") return { data, kind: "mp3", mime: "audio/mpeg", ext: "mp3" };
  if (head === "plaud-encrypted") return { data, kind: "encrypted", mime: "", ext: "" };
  const ex = extractOggOpus(data);
  if (ex) {
    return ex.alreadyClean
      ? { data, kind: "ogg", mime: "audio/ogg", ext: "ogg" }
      : { data: ex.ogg, kind: "ogg-extracted", mime: "audio/ogg", ext: "ogg" };
  }
  const raw = detectRawOpus(data);
  const wrapped = raw ? wrapRawOpus(data, raw) : null;
  if (raw && wrapped) return { data: wrapped, kind: "ogg-wrapped", mime: "audio/ogg", ext: "ogg", raw };
  return { data, kind: "unknown", mime: "", ext: "" };
}
