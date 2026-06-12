import { App, TFile, normalizePath } from "obsidian";
import { PlaudRecordingDetail, PlaudRegion, SttResult } from "./types";
import { formatDuration, formatStartTime } from "./format";
import { convertBibleRefsInNote } from "./bible";

/** 플러그인 소유 본문 구간 마커 — 재동기화 시 이 사이만 교체한다 */
export const PLAUD_CONTENT_START = "<!-- plaud:content:start -->";
export const PLAUD_CONTENT_END = "<!-- plaud:content:end -->";

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

  return fm + buildPlaudBody(detail, region, stt) + "\n";
}

/**
 * 플러그인 소유 본문(마커로 감싼 요약/전사 구간).
 * 신규 임포트와 재동기화가 같은 빌더를 쓴다.
 * - 요약 있음: ## AI 요약 + 접힌 콜아웃 타임스탬프 트랜스크립트
 * - 요약 없음: ## 트랜스크립트 (타임스탬프 평문)
 */
export function buildPlaudBody(
  detail: PlaudRecordingDetail,
  region: PlaudRegion,
  stt?: SttResult
): string {
  const vars = buildVars(detail, region);
  const effectiveTranscript = (stt && !detail.transcript ? stt.text : vars.transcript).trim();

  const body: string[] = [PLAUD_CONTENT_START, ""];
  if (vars.summary.trim()) {
    body.push("## AI 요약", "", vars.summary.trim(), "");
    if (effectiveTranscript) {
      // 접힌 콜아웃 — 펼치면 [m:ss] 타임스탬프 클릭으로 해당 위치 재생 가능
      body.push("> [!note]- 타임스탬프 트랜스크립트 (읽기 모드에서 시간 클릭 → 해당 위치 재생)");
      for (const line of effectiveTranscript.split("\n")) {
        body.push(`> ${line}`);
      }
      body.push("");
    }
  } else {
    body.push("## 트랜스크립트", "");
    body.push(effectiveTranscript || "전사된 트랜스크립트가 없습니다.");
    body.push("");
  }
  body.push(PLAUD_CONTENT_END);
  return body.join("\n");
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
  /** 임포트 직후 성경 구절 자동 wikilink 변환 */
  autoBibleWikilink?: boolean;
}

/** 노트 전체에 성경 구절 wikilink 변환 적용 (frontmatter 보존은 bible.ts가 보장) */
async function applyBibleWikilinks(app: App, file: TFile): Promise<number> {
  try {
    const raw = await app.vault.read(file);
    const { text, count } = convertBibleRefsInNote(raw);
    if (count > 0 && text !== raw) {
      await app.vault.modify(file, text);
    }
    return count;
  } catch (e) {
    console.error("[A4P Plaud] 성경 wikilink 자동 변환 실패", e);
    return 0;
  }
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

  if (options.autoBibleWikilink) {
    await applyBibleWikilinks(app, file);
  }

  return { file, existed: false };
}

export interface ResyncResult {
  /** replaced = 마커 구간 교체, appended = 마커 없어 본문 끝에 추가 */
  mode: "replaced" | "appended";
}

/**
 * 기존 노트의 플러그인 소유 구간(마커 사이)을 서버 최신 요약/전사로 교체한다.
 * 마커가 없는 노트(구버전 임포트)는 본문 끝에 새 구간을 추가한다.
 * 사용자가 노트에 직접 쓴 내용은 건드리지 않는다.
 */
export async function resyncRecording(
  app: App,
  detail: PlaudRecordingDetail,
  file: TFile,
  options: { autoBibleWikilink?: boolean } = {}
): Promise<ResyncResult> {
  const raw = await app.vault.read(file);
  const newBody = buildPlaudBody(detail, "");
  const startIdx = raw.indexOf(PLAUD_CONTENT_START);
  const endIdx = raw.indexOf(PLAUD_CONTENT_END);

  let next: string;
  let mode: ResyncResult["mode"];
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    next = raw.slice(0, startIdx) + newBody + raw.slice(endIdx + PLAUD_CONTENT_END.length);
    mode = "replaced";
  } else {
    next = `${raw.trimEnd()}\n\n${newBody}\n`;
    mode = "appended";
  }

  if (next !== raw) {
    await app.vault.modify(file, next);
  }
  if (options.autoBibleWikilink) {
    await applyBibleWikilinks(app, file);
  }
  return { mode };
}
