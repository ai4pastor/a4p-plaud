/**
 * Plaud의 duration 필드 단위는 ms로 관측됨.
 * 1시간 미만이면 "MM:SS", 이상이면 "H:MM:SS".
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

/**
 * Plaud의 start_time. epoch ms 또는 epoch s 가능 — 큰 값(>1e12)이면 ms로 본다.
 */
function toDate(epoch: number): Date {
  if (!Number.isFinite(epoch) || epoch <= 0) return new Date(0);
  const ms = epoch > 1e12 ? epoch : epoch * 1000;
  return new Date(ms);
}

export function formatStartTime(epoch: number): string {
  const d = toDate(epoch);
  if (d.getTime() === 0) return "";
  const yyyy = d.getFullYear();
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  const hh = d.getHours().toString().padStart(2, "0");
  const mi = d.getMinutes().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

export function formatStartTimeForFilename(epoch: number): string {
  const d = toDate(epoch);
  if (d.getTime() === 0) return "unknown";
  const yyyy = d.getFullYear();
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  const hh = d.getHours().toString().padStart(2, "0");
  const mi = d.getMinutes().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}${mi}`;
}

/** 로그용 URL 요약 — 서명·토큰이 든 쿼리스트링은 버리고 host와 경로 끝(파일명)만 남긴다 */
export function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const tail = parts.length > 1 ? `…/${parts[parts.length - 1]}` : u.pathname;
    return `${u.host}/${tail}`;
  } catch {
    return url.slice(0, 60);
  }
}
