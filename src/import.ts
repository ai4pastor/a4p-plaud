import { App, TFile, normalizePath } from "obsidian";
import { PlaudRecordingDetail, PlaudRegion } from "./types";
import { formatDuration, formatStartTime, formatStartTimeForFilename } from "./format";

export function findNoteByPlaudId(app: App, plaudId: string): TFile | null {
  for (const f of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(f);
    const id = cache?.frontmatter?.plaud_id;
    if (typeof id === "string" && id === plaudId) return f;
  }
  return null;
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function buildFilePath(folder: string, detail: PlaudRecordingDetail): string {
  const stamp = formatStartTimeForFilename(detail.start_time);
  const title = sanitizeFilename(detail.filename || detail.id);
  const base = `${stamp} ${title}`.trim() || detail.id;
  return normalizePath(`${folder}/${base}.md`);
}

function yamlString(value: string): string {
  // 항상 쌍따옴표로 감싸고 백슬래시·따옴표만 이스케이프
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildFrontmatter(
  detail: PlaudRecordingDetail,
  region: PlaudRegion
): string {
  const date = formatStartTime(detail.start_time);
  const importedAt = formatStartTime(Date.now());
  const durationSec = Math.round((detail.duration ?? 0) / 1000);
  const lines = [
    "---",
    `plaud_id: ${yamlString(detail.id)}`,
    `source: plaud`,
    `date: ${yamlString(date)}`,
    `duration_seconds: ${durationSec}`,
    `region: ${yamlString(region)}`,
    `filename: ${yamlString(detail.filename ?? "")}`,
    `imported_at: ${yamlString(importedAt)}`,
    `tags:`,
    `  - plaud`,
    "---",
    "",
  ];
  return lines.join("\n");
}

function buildBody(detail: PlaudRecordingDetail): string {
  const meta =
    `> [!info] Plaud 원본\n` +
    `> id: \`${detail.id}\`\n` +
    `> 길이: ${formatDuration(detail.duration)}  ·  녹음일: ${formatStartTime(
      detail.start_time
    )}\n`;

  const sections: string[] = [meta, ""];

  if (detail.summary && detail.summary.trim()) {
    sections.push("## AI 요약", "", detail.summary.trim(), "");
  }

  sections.push("## 트랜스크립트", "");
  sections.push(
    detail.transcript && detail.transcript.trim()
      ? detail.transcript.trim()
      : "전사된 트랜스크립트가 없습니다."
  );
  sections.push("");

  return sections.join("\n");
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  const normalized = normalizePath(folder);
  const existing = app.vault.getAbstractFileByPath(normalized);
  if (existing) return;
  await app.vault.createFolder(normalized);
}

async function uniquePath(app: App, basePath: string): Promise<string> {
  if (!app.vault.getAbstractFileByPath(basePath)) return basePath;
  const m = basePath.match(/^(.*)\.md$/);
  const stem = m ? m[1] : basePath;
  for (let i = 2; i < 100; i++) {
    const cand = `${stem} (${i}).md`;
    if (!app.vault.getAbstractFileByPath(cand)) return cand;
  }
  throw new Error("동일 파일명으로 중복이 너무 많습니다.");
}

export async function importRecording(
  app: App,
  detail: PlaudRecordingDetail,
  region: PlaudRegion,
  importFolder: string
): Promise<{ file: TFile; existed: boolean }> {
  const existing = findNoteByPlaudId(app, detail.id);
  if (existing) return { file: existing, existed: true };

  await ensureFolder(app, importFolder);
  const desired = buildFilePath(importFolder, detail);
  const finalPath = await uniquePath(app, desired);
  const content = buildFrontmatter(detail, region) + buildBody(detail);
  const file = await app.vault.create(finalPath, content);
  return { file, existed: false };
}
