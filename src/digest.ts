import { App, TFile, normalizePath } from "obsidian";
import type A4PPlaudPlugin from "./main";
import { getRecordingDetail, listRecordings } from "./api";
import { findNoteByPlaudId } from "./import";
import { formatDuration } from "./format";
import { PlaudRecording } from "./types";

/**
 * 기간 다이제스트 노트 — 최근 N일 녹음의 요약을 한 노트로 롤업한다.
 * (공식 plaud-digest 스킬의 플러그인 버전. LLM 합성 없이 조립만.)
 * 임포트된 노트는 wikilink로 연결하고, 미임포트는 제목만 표시한다.
 */

/** 공식 스킬과 동일한 상한 — 초과 시 최신순으로 자른다 */
const MAX_DIGEST_ITEMS = 50;

function ymd(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 요약 발췌 — 헤딩/공백 줄을 걷어내고 앞부분만 */
function summaryExcerpt(summary: string | undefined, maxLen = 300): string {
  if (!summary) return "";
  const lines = summary
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^#{1,6}\s/.test(l) && !/^[*-]{3,}$/.test(l));
  let out = "";
  for (const l of lines) {
    if (out.length + l.length > maxLen) {
      out += out ? " …" : l.slice(0, maxLen) + "…";
      break;
    }
    out += (out ? " " : "") + l;
  }
  return out;
}

async function uniquePath(app: App, basePath: string): Promise<string> {
  if (!app.vault.getAbstractFileByPath(basePath)) return basePath;
  const stem = basePath.replace(/\.md$/, "");
  for (let i = 2; i < 100; i++) {
    const cand = `${stem} (${i}).md`;
    if (!app.vault.getAbstractFileByPath(cand)) return cand;
  }
  throw new Error("동일 파일명으로 중복이 너무 많습니다.");
}

interface DigestItem {
  rec: PlaudRecording;
  excerpt: string;
  hasSummary: boolean;
  hasTranscript: boolean;
  note: TFile | null;
}

export async function createDigestNote(
  app: App,
  plugin: A4PPlaudPlugin,
  days: number
): Promise<TFile> {
  const token = plugin.getToken();
  if (!token) throw new Error("로그인되지 않았습니다.");

  const cutoff = Date.now() - days * 86400000;
  const all = await listRecordings(token);
  let recs = all
    .filter((r) => r.start_time >= cutoff)
    .sort((a, b) => b.start_time - a.start_time);
  if (recs.length === 0) {
    throw new Error(`최근 ${days}일 사이 녹음이 없습니다.`);
  }
  let truncated = false;
  if (recs.length > MAX_DIGEST_ITEMS) {
    recs = recs.slice(0, MAX_DIGEST_ITEMS);
    truncated = true;
  }

  const items: DigestItem[] = [];
  try {
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      plugin.setStatusBar(`Plaud 다이제스트 ${i + 1}/${recs.length}: ${rec.filename}`);
      let excerpt = "";
      let hasSummary = false;
      let hasTranscript = false;
      try {
        const detail = await getRecordingDetail(token, rec.id);
        excerpt = summaryExcerpt(detail.summary);
        hasSummary = !!detail.summary;
        hasTranscript = !!detail.transcript;
      } catch (e) {
        console.warn("[A4P Plaud] 다이제스트 상세 조회 실패(항목은 유지)", rec.id, e);
      }
      items.push({ rec, excerpt, hasSummary, hasTranscript, note: findNoteByPlaudId(app, rec.id) });
      // 서버 부하 완화
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    plugin.setStatusBar("");
  }

  const from = ymd(cutoff);
  const to = ymd(Date.now());
  const totalMs = items.reduce((s, it) => s + (it.rec.duration ?? 0), 0);
  const unimported = items.filter((it) => !it.note).length;

  const lines: string[] = [
    "---",
    "source: plaud-digest",
    `period_days: ${days}`,
    `from: "${from}"`,
    `to: "${to}"`,
    `count: ${items.length}`,
    "tags:",
    "  - plaud",
    "  - digest",
    "---",
    "",
    `# Plaud 다이제스트 ${from} ~ ${to}`,
    "",
    `녹음 **${items.length}개** · 총 **${formatDuration(totalMs)}**` +
      (unimported ? ` · 미임포트 ${unimported}개` : "") +
      (truncated ? ` · ⚠️ 최신 ${MAX_DIGEST_ITEMS}개만 포함(기간 내 녹음이 더 있음)` : ""),
    "",
  ];

  for (const it of items) {
    const date = ymd(it.rec.start_time);
    const title = it.note
      ? `[[${it.note.path.replace(/\.md$/, "")}|${it.note.basename}]]`
      : `${it.rec.filename} *(미임포트)*`;
    lines.push(`## ${date} — ${title}`, "");
    const metaBits = [formatDuration(it.rec.duration)];
    if (it.hasTranscript) metaBits.push("전사 ✓");
    if (it.hasSummary) metaBits.push("요약 ✓");
    lines.push(`- ${metaBits.join(" · ")}`);
    if (it.excerpt) {
      lines.push("", `> ${it.excerpt}`);
    }
    lines.push("");
  }

  const folder = normalizePath(`${plugin.settings.importFolder}/다이제스트`);
  if (!app.vault.getAbstractFileByPath(folder)) {
    await app.vault.createFolder(folder);
  }
  const path = await uniquePath(
    app,
    normalizePath(`${folder}/Plaud 다이제스트 ${from} ~ ${to}.md`)
  );
  return app.vault.create(path, lines.join("\n"));
}
