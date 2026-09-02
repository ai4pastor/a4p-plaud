import { Notice, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import { promises as fs } from "fs";
import * as path from "path";
import { execFile } from "child_process";
import type A4PPlaudPlugin from "./main";
import { getRecordingDetail } from "./api";
import { importRecording } from "./import";
import {
  PlaudWebApiError,
  WebFileType,
  WebSession,
  checkAnalysis,
  getWebFileRaw,
  saveAnalysisResults,
  startAnalysis,
  uploadAudio,
  webDetailToRecordingDetail,
} from "./webapi";
import { PlaudRecordingDetail, WatchLedgerEntry } from "./types";

/**
 * 감시 폴더 자동 업로드 파이프라인.
 *
 * 지정 폴더(vault 안 / 밖·iCloud)에 새 오디오 파일이 나타나면:
 * 업로드(비공식 웹 API) → Plaud 전사·요약 → 결과 되저장 → 노트 자동 임포트.
 *
 * 원칙:
 * - 원본 파일은 어떤 경우에도 이동·수정·삭제하지 않는다 (비파괴).
 * - 처리 기록(ledger)은 data.json에 남겨 재업로드를 막고 재시작 시 이어간다.
 * - 이 기능이 실패해도 기존 공식 API 기능에는 영향이 없다.
 */

/** 업로드 가능한 확장자 → Plaud file_type (presign이 MP3/OPUS만 받음) */
const UPLOADABLE: Record<string, WebFileType> = {
  mp3: "MP3",
  opus: "OPUS",
  asr: "OPUS",
};

/** 오디오이긴 하지만 업로드 불가 — 1회 안내용 */
const KNOWN_AUDIO_EXTS = new Set([
  "m4a", "wav", "aac", "ogg", "flac", "wma", "aiff", "aif", "webm", "mp4", "amr",
]);

/** 파일 크기·수정시각이 이 시간 동안 변하지 않아야 업로드 (복사/동기화 중 방지) */
const STABILIZE_MS = 10_000;
/** 업로드 실패 백오프 (재시도 1·2·3회차) */
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
const MAX_RETRIES = 3;
/** 전사 상태 확인 주기·한도 */
const ANALYSIS_POLL_MS = 30_000;
const ANALYSIS_TIMEOUT_MS = 30 * 60_000;

interface Candidate {
  /** ledger key: vault 상대경로 또는 외부 절대경로 */
  key: string;
  location: "vault" | "external";
  filename: string;
  ext: string;
  size: number;
  mtime: number;
}

interface StabilizingInfo {
  size: number;
  mtime: number;
  firstSeen: number;
}

export interface WatchPreviewItem {
  path: string;
  reason: "신규" | "미지원 형식" | "이미 처리됨" | "iCloud 미다운로드" | "안정화 대기";
}

export class FolderWatcher {
  private pollTimer: number | null = null;
  private stopped = true;
  /** 파이프라인 실행 중 가드 (직렬 큐) */
  private running = false;
  private stabilizing = new Map<string, StabilizingInfo>();
  /** 미지원 형식·중복 등 1회성 Notice 중복 방지 */
  private notified = new Set<string>();
  private vaultEventRegistered = false;

  constructor(private plugin: A4PPlaudPlugin) {}

  private get settings() {
    return this.plugin.settings;
  }

  private enabled(): boolean {
    return (
      this.settings.watchEnabled &&
      (!!this.settings.watchVaultFolder.trim() || !!this.settings.watchExternalFolder.trim()) &&
      this.plugin.hasWebAuth()
    );
  }

  /** 설정 변경 시 settings.ts가 재호출 — 타이머를 재설정한다. */
  start(): void {
    this.stopInternal();
    if (!this.settings.watchEnabled) return;
    if (!this.plugin.hasWebAuth()) {
      if (this.settings.watchVaultFolder.trim() || this.settings.watchExternalFolder.trim()) {
        new Notice("감시 폴더: Plaud 웹 계정이 연결되지 않아 대기합니다. 설정에서 연결해 주세요.");
      }
      return;
    }
    if (!this.enabled()) return;
    this.stopped = false;

    // vault 이벤트는 플러그인 수명 동안 1회만 등록 — 핸들러 안에서 enabled를 확인한다.
    if (!this.vaultEventRegistered) {
      this.vaultEventRegistered = true;
      this.plugin.registerEvent(
        this.plugin.app.vault.on("create", (af: TAbstractFile) => {
          if (this.stopped || !(af instanceof TFile)) return;
          const folder = normalizePath(this.settings.watchVaultFolder.trim().replace(/\/+$/, ""));
          if (!folder || !af.path.startsWith(folder + "/")) return;
          // 파일이 다 써질 때까지 안정화 대기를 거치므로 스캔만 트리거
          window.setTimeout(() => void this.scanNow("event"), 1500);
        })
      );
    }

    const sec = Math.max(15, this.settings.watchPollSeconds || 60);
    this.pollTimer = window.setInterval(() => void this.scanNow("interval"), sec * 1000);
    this.plugin.registerInterval(this.pollTimer);

    void this.scanNow("startup");
  }

  stop(): void {
    this.stopInternal();
  }

  private stopInternal(): void {
    this.stopped = true;
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.stabilizing.clear();
  }

  getQueueSummary(): { pending: number; uploading: number; analyzing: number; done: number; errors: number } {
    const s = { pending: 0, uploading: 0, analyzing: 0, done: 0, errors: 0 };
    for (const e of Object.values(this.settings.watchLedger)) {
      if (e.status === "pending") s.pending++;
      else if (e.status === "uploading") s.uploading++;
      else if (e.status === "analyzing") s.analyzing++;
      else if (e.status === "done") s.done++;
      else if (e.status === "error") s.errors++;
    }
    return s;
  }

  async retryErrors(): Promise<void> {
    let n = 0;
    for (const e of Object.values(this.settings.watchLedger)) {
      if (e.status === "error") {
        e.status = e.fileId ? "analyzing" : "pending";
        e.error = undefined;
        e.retries = 0;
        e.nextRetryAt = 0;
        if (e.fileId && !e.uploadedAt) e.uploadedAt = Date.now();
        n++;
      }
    }
    await this.plugin.persistSettings();
    if (n === 0) {
      new Notice("재시도할 실패 항목이 없습니다.");
      return;
    }
    new Notice(`실패 항목 ${n}개를 다시 큐에 넣었습니다.`);
    void this.scanNow("manual");
  }

  /** dry-run — 업로드 없이 대상만 분류해서 반환 (설정 탭 미리보기 버튼용) */
  async preview(): Promise<WatchPreviewItem[]> {
    const out: WatchPreviewItem[] = [];
    const { candidates, icloudPending, unsupported } = await this.collectCandidates();
    for (const p of icloudPending) out.push({ path: p, reason: "iCloud 미다운로드" });
    for (const p of unsupported) out.push({ path: p, reason: "미지원 형식" });
    for (const c of candidates) {
      const existing = this.settings.watchLedger[c.key];
      if (existing && existing.size === c.size && existing.mtime === c.mtime && existing.status !== "error") {
        out.push({ path: c.key, reason: "이미 처리됨" });
      } else {
        out.push({ path: c.key, reason: "신규" });
      }
    }
    return out;
  }

  // ─────────────────────────────────────────── 스캔

  async scanNow(reason: "startup" | "interval" | "event" | "manual"): Promise<void> {
    if (this.stopped && reason !== "manual") return;
    if (!this.enabled()) return;
    try {
      await this.recoverIfNeeded(reason);
      const { candidates } = await this.collectCandidates();
      const now = Date.now();
      let queued = 0;

      for (const c of candidates) {
        const existing = this.settings.watchLedger[c.key];
        if (existing && existing.size === c.size && existing.mtime === c.mtime) {
          continue; // 동일 파일 — 이미 처리(또는 처리 중/실패 기록 보존)
        }
        if (existing && existing.status === "done") {
          this.noticeOnce(`changed:${c.key}`, `↻ 감시 폴더: ${c.filename} 내용이 바뀌어 새로 업로드합니다.`);
        }

        // 다른 위치에 같은 파일(이름+크기)이 이미 처리됨 → 중복 업로드 방지
        const dup = Object.values(this.settings.watchLedger).find(
          (e) =>
            e.path !== c.key &&
            e.size === c.size &&
            path.basename(e.path) === c.filename &&
            (e.status === "done" || e.status === "analyzing" || e.status === "uploading")
        );
        if (dup) {
          this.settings.watchLedger[c.key] = {
            path: c.key,
            size: c.size,
            mtime: c.mtime,
            status: "skipped",
            retries: 0,
            error: `동일 파일이 이미 처리됨: ${dup.path}`,
          };
          this.noticeOnce(`dup:${c.key}`, `⏭ 감시 폴더: ${c.filename}은(는) 이미 다른 폴더에서 업로드되어 건너뜁니다.`);
          continue;
        }

        // 안정화 대기 — 크기/시각이 STABILIZE_MS 동안 불변이어야 큐 투입
        const st = this.stabilizing.get(c.key);
        if (!st || st.size !== c.size || st.mtime !== c.mtime) {
          this.stabilizing.set(c.key, { size: c.size, mtime: c.mtime, firstSeen: now });
          // 다음 폴링 주기를 기다리지 않고 안정화 시간 직후 재확인
          window.setTimeout(() => void this.scanNow("event"), STABILIZE_MS + 2000);
          continue;
        }
        if (now - st.firstSeen < STABILIZE_MS) continue;
        this.stabilizing.delete(c.key);

        this.settings.watchLedger[c.key] = {
          path: c.key,
          size: c.size,
          mtime: c.mtime,
          status: "pending",
          retries: 0,
        };
        queued++;
      }

      if (queued > 0) await this.plugin.persistSettings();
      await this.processQueue();
    } catch (e) {
      console.error("[A4P Plaud] 감시 폴더 스캔 실패", e);
    }
  }

  /** 재시작 복구: 진행 중 상태를 이어서 처리 가능한 상태로 되돌린다. */
  private async recoverIfNeeded(reason: string): Promise<void> {
    if (reason !== "startup") return;
    let changed = false;
    for (const e of Object.values(this.settings.watchLedger)) {
      if (e.status === "uploading") {
        // fileId가 있으면 업로드는 끝난 것 — 분석부터 재개 (중복 업로드 방지)
        e.status = e.fileId ? "analyzing" : "pending";
        if (e.fileId && !e.uploadedAt) e.uploadedAt = Date.now();
        changed = true;
      }
    }
    if (changed) await this.plugin.persistSettings();
  }

  private async collectCandidates(): Promise<{
    candidates: Candidate[];
    icloudPending: string[];
    unsupported: string[];
  }> {
    const candidates: Candidate[] = [];
    const icloudPending: string[] = [];
    const unsupported: string[] = [];

    // ── vault 폴더 (최상위 파일만)
    const vaultFolder = this.settings.watchVaultFolder.trim().replace(/\/+$/, "");
    if (vaultFolder) {
      const af = this.plugin.app.vault.getAbstractFileByPath(normalizePath(vaultFolder));
      if (af instanceof TFolder) {
        for (const child of af.children) {
          if (!(child instanceof TFile)) continue;
          const ext = child.extension.toLowerCase();
          if (UPLOADABLE[ext]) {
            candidates.push({
              key: child.path,
              location: "vault",
              filename: child.name,
              ext,
              size: child.stat.size,
              mtime: child.stat.mtime,
            });
          } else if (KNOWN_AUDIO_EXTS.has(ext)) {
            unsupported.push(child.path);
            this.noticeOnce(
              `unsupported:${child.path}`,
              `⚠️ ${child.name}: Plaud 업로드는 mp3/opus만 지원합니다 (${ext} 미지원)`
            );
          }
        }
      }
    }

    // ── 외부 폴더 (최상위 파일만, iCloud placeholder 처리)
    const extFolder = this.settings.watchExternalFolder.trim().replace(/\/+$/, "");
    if (extFolder) {
      let names: string[] = [];
      try {
        names = await fs.readdir(extFolder);
      } catch (e) {
        this.noticeOnce(`extmissing:${extFolder}`, `⚠️ 감시 폴더를 열 수 없습니다: ${extFolder}`);
        console.warn("[A4P Plaud] 외부 감시 폴더 읽기 실패", e);
        names = [];
      }
      for (const name of names) {
        // iCloud placeholder: ".{이름}.icloud" — 실제 파일 다운로드 유도
        const icloudMatch = name.match(/^\.(.+)\.icloud$/);
        if (icloudMatch) {
          const realName = icloudMatch[1];
          const realExt = path.extname(realName).slice(1).toLowerCase();
          if (!UPLOADABLE[realExt] && !KNOWN_AUDIO_EXTS.has(realExt)) continue;
          const realPath = path.join(extFolder, realName);
          icloudPending.push(realPath);
          this.noticeOnce(`icloud:${realPath}`, `☁️ iCloud에서 내려받는 중: ${realName}`);
          this.triggerICloudDownload(realPath);
          continue;
        }
        if (name.startsWith(".")) continue;
        const ext = path.extname(name).slice(1).toLowerCase();
        if (!UPLOADABLE[ext]) {
          if (KNOWN_AUDIO_EXTS.has(ext)) {
            const full = path.join(extFolder, name);
            unsupported.push(full);
            this.noticeOnce(
              `unsupported:${full}`,
              `⚠️ ${name}: Plaud 업로드는 mp3/opus만 지원합니다 (${ext} 미지원)`
            );
          }
          continue;
        }
        const full = path.join(extFolder, name);
        try {
          const st = await fs.stat(full);
          if (!st.isFile()) continue;
          candidates.push({
            key: full,
            location: "external",
            filename: name,
            ext,
            size: st.size,
            mtime: Math.floor(st.mtimeMs),
          });
        } catch {
          // 스캔 사이에 사라짐 — 무시
        }
      }
    }

    return { candidates, icloudPending, unsupported };
  }

  /** macOS: brctl로 iCloud 파일 다운로드 트리거 (실패해도 무시 — 열기 시도로도 유도) */
  private triggerICloudDownload(realPath: string): void {
    if (process.platform === "darwin") {
      try {
        execFile("brctl", ["download", realPath], () => {
          // 결과 무시 — 다음 폴링 주기에 실제 파일 존재로 확인
        });
        return;
      } catch {
        // fall through
      }
    }
    void fs.open(realPath, "r").then((h) => h.close()).catch(() => undefined);
  }

  private noticeOnce(key: string, message: string): void {
    if (this.notified.has(key)) return;
    this.notified.add(key);
    new Notice(message, 8000);
  }

  // ─────────────────────────────────────────── 파이프라인 (직렬)

  private async processQueue(): Promise<void> {
    if (this.running) return;
    const session = this.plugin.getWebSession();
    if (!session) return;
    this.running = true;
    try {
      for (;;) {
        if (this.stopped) break;

        // 1) 업로드 대기 항목 우선
        const pending = this.nextPending();
        if (pending) {
          await this.uploadOne(session, pending);
          continue;
        }

        // 2) 전사 진행 중 항목 확인
        const analyzing = Object.values(this.settings.watchLedger).filter(
          (e) => e.status === "analyzing"
        );
        if (analyzing.length === 0) break;

        for (const e of analyzing) {
          if (this.stopped) break;
          await this.checkOne(session, e);
        }

        const stillAnalyzing = Object.values(this.settings.watchLedger).some(
          (e) => e.status === "analyzing"
        );
        if (!stillAnalyzing) continue; // 새 pending이 생겼을 수 있으니 루프 재진입
        await sleep(ANALYSIS_POLL_MS);
      }
    } finally {
      this.running = false;
      this.plugin.setStatusBar("");
    }
  }

  private nextPending(): WatchLedgerEntry | null {
    const now = Date.now();
    for (const e of Object.values(this.settings.watchLedger)) {
      if (e.status !== "pending") continue;
      if (e.nextRetryAt && e.nextRetryAt > now) continue;
      return e;
    }
    return null;
  }

  private async uploadOne(session: WebSession, entry: WatchLedgerEntry): Promise<void> {
    const filename = path.basename(entry.path);
    const displayName = filename.replace(/\.[^.]+$/, "");
    const ext = path.extname(entry.path).slice(1).toLowerCase();
    const fileType = UPLOADABLE[ext];
    if (!fileType) {
      entry.status = "skipped";
      entry.error = `미지원 형식: ${ext}`;
      await this.plugin.persistSettings();
      return;
    }

    entry.status = "uploading";
    await this.plugin.persistSettings();

    try {
      // 재시도 항목: 업로드는 이미 성공(fileId 존재) → 분석 시작부터 재개
      if (!entry.fileId) {
        const data = await this.readFile(entry.path);
        this.plugin.setStatusBar(`⬆ Plaud 업로드: ${filename}`);
        const { fileId } = await uploadAudio(session, {
          data,
          fileType,
          filename: displayName,
          startTimeMs: entry.mtime || Date.now(),
          onProgress: (stage, part, total) => {
            if (stage === "put" && part && total && total > 1) {
              this.plugin.setStatusBar(`⬆ Plaud 업로드: ${filename} (${part}/${total})`);
            }
          },
        });
        entry.fileId = fileId;
        await this.plugin.persistSettings();
      }

      this.plugin.setStatusBar(`🎙 Plaud 전사 요청: ${filename}`);
      await startAnalysis(session, entry.fileId, this.settings.watchLanguage);

      entry.status = "analyzing";
      entry.uploadedAt = Date.now();
      entry.error = undefined;
      await this.plugin.persistSettings();
      new Notice(
        `⬆ 업로드 완료 — Plaud 전사 시작: ${filename}\n(요금제 전사 시간이 차감됩니다)`,
        8000
      );
    } catch (e) {
      await this.handleFailure(entry, e, `업로드 실패: ${filename}`);
    } finally {
      this.plugin.setStatusBar("");
    }
  }

  private async checkOne(session: WebSession, entry: WatchLedgerEntry): Promise<void> {
    if (!entry.fileId) {
      entry.status = "pending";
      await this.plugin.persistSettings();
      return;
    }
    const filename = path.basename(entry.path);
    try {
      const { complete, raw } = await checkAnalysis(session, entry.fileId, this.settings.watchLanguage);
      if (!complete) {
        const started = entry.uploadedAt ?? Date.now();
        if (Date.now() - started > ANALYSIS_TIMEOUT_MS) {
          entry.status = "error";
          entry.error = "전사 시간 초과 — Plaud 앱에서 상태를 확인해 주세요. (파일은 이미 계정에 올라가 있습니다)";
          await this.plugin.persistSettings();
          new Notice(`⏱ ${filename}: ${entry.error}`, 10000);
        }
        return;
      }

      // 필수: 결과 되저장 — 생략하면 클라우드 레코드에 전사가 남지 않는다
      try {
        await saveAnalysisResults(session, entry.fileId, raw);
      } catch (e) {
        console.warn("[A4P Plaud] 전사 결과 되저장 실패 — 다음 확인 주기에 재시도", e);
        return; // analyzing 유지 → 다음 패스에서 checkAnalysis부터 다시
      }

      if (this.settings.watchAutoImport) {
        await this.importOne(session, entry, filename);
      } else {
        entry.status = "done";
        entry.doneAt = Date.now();
        await this.plugin.persistSettings();
        new Notice(`✅ Plaud 전사 완료: ${filename} (자동 임포트 꺼짐 — 패널에서 가져올 수 있습니다)`, 8000);
      }
    } catch (e) {
      if (e instanceof PlaudWebApiError && e.code === "UNAUTHORIZED") {
        // 세션 만료 — 큐를 멈추고 사용자 재연결 대기 (analyzing 상태 유지)
        this.noticeOnce("webauth", "Plaud 웹 연결이 만료되었습니다. 설정에서 다시 연결해 주세요.");
        this.stopped = true;
        return;
      }
      console.warn("[A4P Plaud] 전사 상태 확인 실패 — 다음 주기에 재시도", entry.path, e);
    }
  }

  private async importOne(
    session: WebSession,
    entry: WatchLedgerEntry,
    filename: string
  ): Promise<void> {
    if (!entry.fileId) return;
    let detail: PlaudRecordingDetail | null = null;

    // 1순위: 공식 API — 기존 임포트 경로와 완전히 동일한 데이터 형태
    const officialToken = this.plugin.getToken();
    if (officialToken) {
      try {
        detail = await getRecordingDetail(officialToken, entry.fileId);
        if (!detail.transcript && !detail.summary) detail = null; // 반영 지연 — 웹 폴백
      } catch (e) {
        console.warn("[A4P Plaud] 공식 API detail 실패 — 웹 API 폴백", entry.fileId, e);
      }
    }
    // 2순위: 비공식 웹 API raw → 어댑터
    if (!detail) {
      const raw = await getWebFileRaw(session, entry.fileId);
      detail = webDetailToRecordingDetail(raw);
    }

    try {
      const { file, existed } = await importRecording(
        this.plugin.app,
        detail,
        "",
        this.settings.importFolder,
        {
          templatePath: this.settings.templatePath,
          autoBibleWikilink: this.settings.autoBibleWikilink,
        }
      );
      entry.notePath = file.path;
      entry.status = "done";
      entry.doneAt = Date.now();
      await this.plugin.persistSettings();
      new Notice(existed ? `✅ ${filename}: 기존 노트에 연결됨 (${file.path})` : `✅ 녹음 노트 생성: ${file.path}`, 8000);
    } catch (e) {
      // 전사까지는 성공 — 임포트만 실패한 상태를 구분해 기록
      entry.status = "error";
      entry.error = `노트 임포트 실패: ${(e as Error).message ?? "unknown"} (전사는 Plaud 계정에 저장됨)`;
      await this.plugin.persistSettings();
      new Notice(`⚠️ ${filename}: ${entry.error}`, 10000);
    }
  }

  private async handleFailure(entry: WatchLedgerEntry, e: unknown, prefix: string): Promise<void> {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[A4P Plaud] ${prefix}`, entry.path, e);

    if (e instanceof PlaudWebApiError && e.code === "UNAUTHORIZED") {
      entry.status = "pending";
      entry.nextRetryAt = Date.now() + RETRY_BACKOFF_MS[0];
      await this.plugin.persistSettings();
      this.noticeOnce("webauth", "Plaud 웹 연결이 만료되었습니다. 설정에서 다시 연결해 주세요.");
      this.stopped = true;
      return;
    }

    entry.retries++;
    if (entry.retries >= MAX_RETRIES) {
      entry.status = "error";
      entry.error = msg;
      new Notice(`❌ ${prefix} (${entry.retries}회 시도): ${msg}\n설정 또는 명령어로 재시도할 수 있습니다.`, 10000);
    } else {
      entry.status = "pending";
      entry.error = msg;
      entry.nextRetryAt = Date.now() + RETRY_BACKOFF_MS[Math.min(entry.retries - 1, RETRY_BACKOFF_MS.length - 1)];
    }
    await this.plugin.persistSettings();
  }

  private async readFile(key: string): Promise<ArrayBuffer> {
    const af = this.plugin.app.vault.getAbstractFileByPath(normalizePath(key));
    if (af instanceof TFile) {
      return this.plugin.app.vault.readBinary(af);
    }
    // 외부 절대경로
    const buf = await fs.readFile(key);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
