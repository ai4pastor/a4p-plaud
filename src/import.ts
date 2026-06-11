import { App, TFile, normalizePath } from "obsidian";
import { PlaudRecordingDetail, PlaudRegion, SttResult } from "./types";
import { formatDuration, formatStartTime } from "./format";

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
  const title = sanitizeFilename(detail.filename || detail.id);
  const base = title || detail.id;
  return normalizePath(`${folder}/${base}.md`);
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

interface TemplateVars {
  plaud_id: string;
  transcript: string;
  summary: string;
  filename: string;
  date: string;
  duration: string;
  duration_seconds: string;
  region: string;
  imported_at: string;
}

function buildVars(detail: PlaudRecordingDetail, region: PlaudRegion): TemplateVars {
  const durationSec = Math.round((detail.duration ?? 0) / 1000);
  return {
    plaud_id: detail.id,
    transcript: detail.transcript ?? "",
    summary: detail.summary ?? "",
    filename: detail.filename ?? "",
    date: formatStartTime(detail.start_time),
    duration: formatDuration(detail.duration),
    duration_seconds: String(durationSec),
    region,
    imported_at: formatStartTime(Date.now()),
  };
}

export function applyTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    const v = (vars as unknown as Record<string, string>)[key];
    return v ?? "";
  });
}

function buildDefaultContent(
  detail: PlaudRecordingDetail,
  region: PlaudRegion,
  stt?: SttResult
): string {
  const vars = buildVars(detail, region);
  const fmLines = [
    "---",
    `plaud_id: ${yamlString(vars.plaud_id)}`,
    `source: plaud`,
    `date: ${yamlString(vars.date)}`,
    `duration_seconds: ${vars.duration_seconds}`,
    `region: ${yamlString(vars.region)}`,
    `filename: ${yamlString(vars.filename)}`,
    `imported_at: ${yamlString(vars.imported_at)}`,
  ];
  if (stt) {
    fmLines.push(`stt_provider: ${yamlString(stt.provider)}`);
    fmLines.push(`stt_model: ${yamlString(stt.model)}`);
    fmLines.push(`stt_at: ${yamlString(formatStartTime(stt.at))}`);
    if (stt.language) fmLines.push(`stt_language: ${yamlString(stt.language)}`);
  }
  fmLines.push(`tags:`, `  - plaud`, "---", "");
  const fm = fmLines.join("\n");

  const body: string[] = [];
  if (vars.summary.trim()) {
    // AI 요약(정제된 전체 전사 포함)이 있으면 타임스탬프 트랜스크립트는 생략
    body.push("## AI 요약", "", vars.summary.trim(), "");
  } else {
    body.push("## 트랜스크립트", "");
    body.push(vars.transcript.trim() || "전사된 트랜스크립트가 없습니다.");
    body.push("");
  }

  return fm + body.join("\n");
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

async function loadTemplateContent(app: App, path: string): Promise<string | null> {
  if (!path) return null;
  const af = app.vault.getAbstractFileByPath(normalizePath(path));
  if (!(af instanceof TFile)) return null;
  try {
    return await app.vault.read(af);
  } catch {
    return null;
  }
}

/**
 * 옵션 X 모드: 본문/frontmatter는 플러그인이 책임지고, 사용자 템플릿은 스크립트(<%* ... _%>)만 기여.
 * 템플릿 시작 부분에 frontmatter 블록이 있으면 제거 — 안 그러면 우리 frontmatter 다음에 두 번째 yaml 블록이 본문에 박힘.
 */
function stripLeadingFrontmatter(content: string): string {
  const c = content.replace(/^﻿/, "");
  const m = c.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (m) return c.slice(m[0].length);
  return c;
}

/**
 * Templater 처리 후 본문 안에 또 다른 frontmatter 블록이 끼어들어 있으면(예: 사용자 스크립트가 tR로 출력) 제거.
 * 첫 frontmatter는 그대로 두고 두 번째 이후 ---..--- 블록만 제거.
 */
function removeExtraFrontmatterBlocks(content: string): string {
  const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!fmMatch) return content;
  const head = content.slice(0, fmMatch[0].length);
  const tail = content.slice(fmMatch[0].length);
  const cleaned = tail.replace(/(?:^|\n)---\r?\n[\s\S]*?\r?\n---\r?\n?/g, "\n");
  return head + cleaned;
}

interface TemplaterApi {
  overwrite_file_commands?: (file: TFile, active_file?: boolean) => Promise<void>;
}

function getTemplaterApi(app: App): TemplaterApi | null {
  const plugins = (app as unknown as {
    plugins?: { plugins?: Record<string, { templater?: TemplaterApi }> };
  }).plugins?.plugins;
  return plugins?.["templater-obsidian"]?.templater ?? null;
}

/**
 * Templater 처리 중 사용자 스크립트가 부르는 app.fileManager.processFrontMatter를 가로채서
 * 사용자가 넣은 frontmatter를 capture → Templater가 본문을 디스크에 덮어쓴 뒤 우리가 재적용한다.
 *
 * 이유: Templater의 overwrite_file_commands는 본문 처리 결과로 디스크 전체를 다시 쓰는데,
 * 사용자 스크립트가 그 사이에 호출한 processFrontMatter 결과는 메모리상 본문에 반영되지 않아
 * 결과적으로 사라짐. capture & re-apply로 보존.
 */
async function runTemplaterOnDisk(app: App, file: TFile): Promise<boolean> {
  const tpl = getTemplaterApi(app);
  if (!tpl || typeof tpl.overwrite_file_commands !== "function") return false;

  const fm = (app as unknown as {
    fileManager: {
      processFrontMatter: (
        f: TFile,
        fn: (frontmatter: Record<string, unknown>) => void,
        options?: unknown
      ) => Promise<void>;
    };
  }).fileManager;

  const original = fm.processFrontMatter.bind(fm);
  const captured: Record<string, unknown> = {};
  let capturedAny = false;

  fm.processFrontMatter = async (f, userFn, options) => {
    if (f.path === file.path) {
      return original(
        f,
        (mm: Record<string, unknown>) => {
          userFn(mm);
          for (const k of Object.keys(mm)) captured[k] = mm[k];
          capturedAny = true;
        },
        options
      );
    }
    return original(f, userFn, options);
  };

  try {
    await tpl.overwrite_file_commands(file, false);
  } catch (e) {
    console.error("[A4P Plaud] Templater overwrite_file_commands 실패", e);
  } finally {
    fm.processFrontMatter = original;
  }

  if (capturedAny) {
    // Templater가 본문 덮어쓴 직후 디스크 안정화 잠시 대기
    await new Promise((r) => setTimeout(r, 50));
    try {
      await original(file, (mm: Record<string, unknown>) => {
        for (const k of Object.keys(captured)) mm[k] = captured[k];
      });
    } catch (e) {
      console.error("[A4P Plaud] captured frontmatter 재적용 실패", e);
    }
  }

  // 안전망: 사용자 템플릿이 본문에 또 다른 ---...--- 블록을 출력한 경우 제거
  try {
    const raw = await app.vault.read(file);
    const cleaned = removeExtraFrontmatterBlocks(raw);
    if (cleaned !== raw) {
      await app.vault.modify(file, cleaned);
    }
  } catch (e) {
    console.error("[A4P Plaud] 추가 frontmatter 정리 실패", e);
  }

  return true;
}

export interface ImportOptions {
  templatePath?: string;
  runTemplater?: boolean;
  /** 외부 STT 결과 — frontmatter에 출처 메타 기록 */
  stt?: SttResult;
}

export async function importRecording(
  app: App,
  detail: PlaudRecordingDetail,
  region: PlaudRegion,
  importFolder: string,
  options: ImportOptions = {}
): Promise<{ file: TFile; existed: boolean }> {
  const existing = findNoteByPlaudId(app, detail.id);
  if (existing) return { file: existing, existed: true };

  await ensureFolder(app, importFolder);
  const desired = buildFilePath(importFolder, detail);
  const finalPath = await uniquePath(app, desired);

  const vars = buildVars(detail, region);
  const defaultContent = buildDefaultContent(detail, region, options.stt);
  const tpl = await loadTemplateContent(app, options.templatePath ?? "");

  let content: string;
  if (tpl !== null) {
    // 옵션 X: 본문은 플러그인이 채우고, 사용자 템플릿 스크립트만 본문 끝에 append.
    // 템플릿 시작의 frontmatter boilerplate는 제거 (안 그러면 본문 안에 두 번째 yaml 블록이 박힘).
    const tplApplied = applyTemplate(stripLeadingFrontmatter(tpl), vars);
    content = `${defaultContent}\n${tplApplied}`;
  } else {
    content = defaultContent;
  }

  const file = await app.vault.create(finalPath, content);

  if (options.runTemplater !== false && tpl !== null) {
    // 에디터를 안 거치고 디스크에 직접 적용 → 사용자 스크립트의 processFrontMatter가
    // 마지막 setValue로 덮어씌워지는 문제 회피.
    await runTemplaterOnDisk(app, file);
  }

  return { file, existed: false };
}
