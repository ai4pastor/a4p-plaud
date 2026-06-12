import {
  App,
  Component,
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  Modal,
  Notice,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import type A4PPlaudPlugin from "./main";
import { getMp3Url, getRecordingDetail, listRecordings, msToClock, PlaudApiError } from "./api";
import { PlaudAuthError } from "./auth";
import { formatDuration, formatStartTime } from "./format";
import { findNoteByPlaudId, importRecording } from "./import";
import {
  PlaudRecording,
  PlaudRecordingDetail,
  STT_COST_PER_HOUR,
  STT_MAX_FILE_SIZE,
  SttResult,
} from "./types";
import { downloadMp3, SttError, transcribeAudio } from "./stt";

/** 세션 동안 plaud_id → STT 결과 캐시 (모달 닫혀도 유지) */
const sttCache: Map<string, SttResult> = new Map();
/** 진행 중 plaud_id → 상태 텍스트 (상태바·모달 공유) */
const sttInProgress: Map<string, string> = new Map();

export const PLAUD_VIEW_TYPE = "a4p-plaud-list-view";

export class PlaudListView extends ItemView {
  plugin: A4PPlaudPlugin;
  private recordings: PlaudRecording[] = [];
  private filtered: PlaudRecording[] = [];
  private query = "";
  private loading = false;
  private listContainer: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private playerContainer: HTMLElement | null = null;
  private currentPlaudId: string | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private playButton: HTMLButtonElement | null = null;
  private plaudIdIndex: Map<string, TFile> = new Map();
  private highlightedCardEl: HTMLElement | null = null;
  private sortOrder: "desc" | "asc" = "desc";
  private sortBtnEl: HTMLButtonElement | null = null;
  private batchBtnEl: HTMLButtonElement | null = null;
  private batchRunning = false;

  constructor(leaf: WorkspaceLeaf, plugin: A4PPlaudPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return PLAUD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Plaud";
  }

  getIcon(): string {
    return "microphone";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("a4p-plaud-view");
    root.style.display = "flex";
    root.style.flexDirection = "column";
    root.style.height = "100%";

    const toolbar = root.createDiv({ cls: "a4p-plaud-toolbar" });
    toolbar.style.display = "flex";
    toolbar.style.gap = "6px";
    toolbar.style.padding = "8px";
    toolbar.style.borderBottom = "1px solid var(--background-modifier-border)";
    toolbar.style.flex = "0 0 auto";

    const search = toolbar.createEl("input", { type: "text" });
    search.placeholder = "검색 (파일명/키워드)";
    search.style.flex = "1";
    search.addEventListener("input", () => {
      this.query = search.value.trim().toLowerCase();
      this.applyFilter();
    });

    const refresh = toolbar.createEl("button", { text: "↻" });
    refresh.title = "새로고침";
    refresh.addEventListener("click", () => this.reload());

    const batchBtn = toolbar.createEl("button", { text: "" });
    batchBtn.title = "미임포트 녹음 모두 가져오기";
    batchBtn.style.display = "none";
    batchBtn.addEventListener("click", () => void this.importAllMissing());
    this.batchBtnEl = batchBtn;

    this.playerContainer = root.createDiv({ cls: "a4p-plaud-player" });
    this.playerContainer.style.borderBottom = "1px solid var(--background-modifier-border)";
    this.playerContainer.style.padding = "8px";
    this.playerContainer.style.flex = "0 0 auto";
    this.renderPlayerEmpty();

    const statusBar = root.createDiv({ cls: "a4p-plaud-status-bar" });
    this.statusEl = statusBar.createDiv({ cls: "a4p-plaud-status-text" });

    const sortBtn = statusBar.createEl("button", {
      cls: "a4p-plaud-sort-btn",
      text: this.sortLabel(),
    });
    sortBtn.title = "정렬 순서 토글";
    sortBtn.addEventListener("click", () => {
      this.sortOrder = this.sortOrder === "desc" ? "asc" : "desc";
      sortBtn.setText(this.sortLabel());
      this.applySort();
      this.applyFilter();
    });
    this.sortBtnEl = sortBtn;

    this.listContainer = root.createDiv({ cls: "a4p-plaud-list" });
    this.listContainer.style.overflow = "auto";
    this.listContainer.style.padding = "0 4px 8px 4px";
    this.listContainer.style.flex = "1 1 auto";
    this.listContainer.style.minHeight = "0";

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () =>
        this.refreshPlayerFromFile(this.app.workspace.getActiveFile())
      )
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => this.refreshPlayerFromFile(file))
    );
    // 임포트된 노트가 삭제되면 카드 상태를 즉시 "미임포트"로 되돌린다 (재임포트 가능)
    this.registerEvent(
      this.app.vault.on("delete", (af) => {
        let changed = false;
        for (const [id, f] of this.plaudIdIndex) {
          if (f.path === af.path) {
            this.plaudIdIndex.delete(id);
            changed = true;
          }
        }
        if (changed) {
          this.renderList();
          this.updateBatchBadge();
        }
      })
    );

    await this.reload();
    this.refreshPlayerFromFile(this.app.workspace.getActiveFile());
  }

  async onClose(): Promise<void> {
    if (this.audioEl) {
      try {
        this.audioEl.pause();
        this.audioEl.removeAttribute("src");
        this.audioEl.load();
      } catch {
        // ignore
      }
    }
    this.audioEl = null;
    this.playButton = null;
    this.playerContainer = null;
    this.currentPlaudId = null;
  }

  private refreshPlayerFromFile(file: TFile | null): void {
    if (!this.playerContainer) return;
    if (!file) return;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const id = typeof fm?.plaud_id === "string" ? fm.plaud_id : null;
    console.log("[A4P Plaud] refreshPlayerFromFile", { path: file.path, id });
    // 일반 노트(plaud_id 없음)로 전환 시엔 플레이어를 비우지 않고 그대로 둠.
    if (id) {
      this.setPlayerForId(id);
    }
  }

  private highlightCardForId(id: string | null, scroll: boolean): void {
    const c = this.listContainer;
    if (!c) return;
    if (this.highlightedCardEl) {
      this.highlightedCardEl.removeClass("a4p-plaud-card-active");
      this.highlightedCardEl = null;
    }
    if (!id) return;
    const sel = `.a4p-plaud-card[data-plaud-id="${CSS.escape(id)}"]`;
    const el = c.querySelector(sel) as HTMLElement | null;
    console.log("[A4P Plaud] highlightCardForId", { id, found: !!el });
    if (!el) return;
    // 펄스 애니메이션 재시작을 위해 class를 강제로 제거 후 다시 추가
    el.removeClass("a4p-plaud-card-active");
    // reflow 강제
    void el.offsetWidth;
    el.addClass("a4p-plaud-card-active");
    this.highlightedCardEl = el;
    if (scroll) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  private setPlayerForId(id: string | null): void {
    if (id === this.currentPlaudId) {
      // 같은 id라도 하이라이트는 재트리거 (펄스 다시)
      if (id) this.highlightCardForId(id, true);
      return;
    }
    if (this.audioEl) {
      try {
        this.audioEl.pause();
        this.audioEl.removeAttribute("src");
        this.audioEl.load();
      } catch {
        // ignore
      }
    }
    this.currentPlaudId = id;
    if (!id) {
      this.renderPlayerEmpty();
      this.highlightCardForId(null, false);
      return;
    }
    this.renderPlayerReady(id);
    this.highlightCardForId(id, true);
  }

  private renderPlayerEmpty(): void {
    const c = this.playerContainer;
    if (!c) return;
    c.empty();
    const msg = c.createDiv();
    msg.style.color = "var(--text-muted)";
    msg.style.fontSize = "0.85em";
    msg.setText("아래 목록에서 녹음을 선택한 뒤 ▶ 버튼을 누르세요.");
    this.audioEl = null;
    this.playButton = null;
  }

  private renderPlayerReady(id: string): void {
    const c = this.playerContainer;
    if (!c) return;
    c.empty();

    const meta = c.createDiv();
    meta.style.fontSize = "0.9em";
    meta.style.marginBottom = "6px";
    meta.style.overflow = "hidden";
    meta.style.textOverflow = "ellipsis";
    meta.style.whiteSpace = "nowrap";
    const rec = this.recordings.find((r) => r.id === id);
    if (rec) {
      meta.setText(`🎙 ${rec.filename}  ·  ${formatDuration(rec.duration)}`);
    } else {
      meta.setText(`🎙 ${id.slice(0, 16)}...`);
    }

    const controls = c.createDiv();
    controls.style.display = "flex";
    controls.style.gap = "4px";
    controls.style.alignItems = "center";
    controls.style.flexWrap = "wrap";
    controls.style.marginBottom = "6px";

    const playBtn = controls.createEl("button", { text: "▶ 재생" });
    playBtn.addClass("mod-cta");
    this.playButton = playBtn;
    playBtn.addEventListener("click", () => void this.togglePlay(id));

    const back10 = controls.createEl("button", { text: "⏪10" });
    back10.addEventListener("click", () => {
      if (this.audioEl) this.audioEl.currentTime = Math.max(0, this.audioEl.currentTime - 10);
    });
    const fwd10 = controls.createEl("button", { text: "10⏩" });
    fwd10.addEventListener("click", () => {
      if (this.audioEl) this.audioEl.currentTime = this.audioEl.currentTime + 10;
    });

    for (const s of [1.0, 1.5, 2.0]) {
      const btn = controls.createEl("button", { text: `${s}x` });
      btn.addEventListener("click", () => {
        if (this.audioEl) this.audioEl.playbackRate = s;
      });
    }

    const audio = c.createEl("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.style.width = "100%";
    this.audioEl = audio;
    audio.addEventListener("play", () => {
      if (this.playButton) this.playButton.setText("⏸ 일시정지");
    });
    audio.addEventListener("pause", () => {
      if (this.playButton) this.playButton.setText("▶ 재생");
    });
    audio.addEventListener("error", () => {
      if (id === this.currentPlaudId) void this.handleAudioError(id);
    });
  }

  private async togglePlay(id: string): Promise<void> {
    if (!this.audioEl) return;
    if (!this.audioEl.src) {
      await this.loadAndPlay(id, 0);
      return;
    }
    if (this.audioEl.paused) {
      try {
        await this.audioEl.play();
      } catch {
        // user gesture issue — ignore
      }
    } else {
      this.audioEl.pause();
    }
  }

  private async loadAndPlay(id: string, resumeAt: number): Promise<void> {
    const token = this.plugin.getToken();
    if (!token) {
      new Notice("로그인되지 않았습니다.");
      return;
    }
    if (!this.audioEl) return;
    const btn = this.playButton;
    if (btn) btn.setText("로딩...");
    try {
      const url = await getMp3Url(token, id);
      if (!url) {
        new Notice("mp3 URL을 받지 못했습니다. (전사·요약 처리 중이거나 권한 문제일 수 있습니다)");
        if (btn) btn.setText("▶ 재생");
        return;
      }
      this.audioEl.src = url;
      if (resumeAt > 0) {
        const seekHandler = () => {
          if (this.audioEl) this.audioEl.currentTime = resumeAt;
          this.audioEl?.removeEventListener("loadedmetadata", seekHandler);
        };
        this.audioEl.addEventListener("loadedmetadata", seekHandler);
      }
      await this.audioEl.play();
    } catch (e) {
      new Notice(`재생 실패: ${(e as Error).message ?? "unknown"}`);
      if (btn) btn.setText("▶ 재생");
    }
  }

  private async handleAudioError(id: string): Promise<void> {
    if (!this.audioEl) return;
    const lastTime = this.audioEl.currentTime;
    if (!this.audioEl.src) return;
    new Notice("재생 URL이 만료된 것 같습니다. 갱신해 다시 시도합니다.");
    await this.loadAndPlay(id, lastTime);
  }

  /** 현재 오디오가 재생 중인지 */
  isAudioPlaying(): boolean {
    return !!this.audioEl && !!this.audioEl.src && !this.audioEl.paused;
  }

  /** 재생 중이면 일시정지, 멈춰 있으면 재개. 토글 후 재생 상태를 반환. */
  togglePlayPause(): boolean {
    if (!this.audioEl || !this.audioEl.src) return false;
    if (this.audioEl.paused) {
      void this.audioEl.play().catch(() => {
        // user gesture issue — ignore
      });
      return true;
    }
    this.audioEl.pause();
    return false;
  }

  /** 타임스탬프 점프 — 해당 녹음을 지정 위치(초)부터 재생. 모달·노트 post-processor에서 호출. */
  async playAt(id: string, seconds: number): Promise<void> {
    this.setPlayerForId(id);
    if (!this.audioEl) return;
    if (this.audioEl.src && this.currentPlaudId === id) {
      this.audioEl.currentTime = seconds;
      try {
        await this.audioEl.play();
      } catch {
        // user gesture issue — ignore
      }
      return;
    }
    await this.loadAndPlay(id, seconds);
  }

  /** 미임포트 녹음 수 배지 갱신 */
  private updateBatchBadge(): void {
    const btn = this.batchBtnEl;
    if (!btn) return;
    const missing = this.recordings.filter((r) => !this.plaudIdIndex.has(r.id)).length;
    if (missing > 0 && !this.batchRunning) {
      btn.style.display = "";
      btn.setText(`⬇ ${missing}`);
      btn.title = `미임포트 녹음 ${missing}개 모두 가져오기`;
    } else {
      btn.style.display = "none";
    }
  }

  /** 미임포트 녹음 일괄 임포트 (순차, 진행 상태 표시) */
  private async importAllMissing(): Promise<void> {
    if (this.batchRunning) return;
    const token = this.plugin.getToken();
    if (!token) {
      new Notice("로그인되지 않았습니다.");
      return;
    }
    const missing = this.recordings.filter((r) => !this.plaudIdIndex.has(r.id));
    if (missing.length === 0) {
      new Notice("미임포트 녹음이 없습니다.");
      return;
    }
    const tplNote = this.plugin.settings.templatePath
      ? "\n(설정된 Templater 템플릿이 각 노트에 적용됩니다)"
      : "";
    if (!window.confirm(`미임포트 녹음 ${missing.length}개를 모두 노트로 가져올까요?${tplNote}`)) {
      return;
    }

    this.batchRunning = true;
    this.updateBatchBadge();
    let ok = 0;
    let fail = 0;
    try {
      for (let i = 0; i < missing.length; i++) {
        const rec = missing[i];
        const progress = `Plaud 일괄 임포트 ${i + 1}/${missing.length}`;
        this.plugin.setStatusBar(progress);
        this.setStatus(`${progress}: ${rec.filename}`);
        try {
          const tok = this.plugin.getToken();
          if (!tok) throw new Error("로그인 세션이 끊어졌습니다.");
          const detail = await getRecordingDetail(tok, rec.id);
          const { file } = await importRecording(this.app, detail, "", this.plugin.settings.importFolder, {
            templatePath: this.plugin.settings.templatePath || undefined,
            autoBibleWikilink: this.plugin.settings.autoBibleWikilink,
          });
          this.plaudIdIndex.set(rec.id, file);
          ok++;
        } catch (e) {
          fail++;
          console.error("[A4P Plaud] 일괄 임포트 실패", rec.id, e);
        }
        // 서버 부하 완화
        await new Promise((r) => setTimeout(r, 300));
      }
    } finally {
      this.batchRunning = false;
      this.plugin.setStatusBar("");
    }
    new Notice(`일괄 임포트 완료: 성공 ${ok}개${fail ? `, 실패 ${fail}개` : ""}`);
    this.applyFilter();
  }

  private sortLabel(): string {
    return this.sortOrder === "desc" ? "↓ 최신순" : "↑ 오래된순";
  }

  private applySort(): void {
    if (this.sortOrder === "desc") {
      this.recordings.sort((a, b) => b.start_time - a.start_time);
    } else {
      this.recordings.sort((a, b) => a.start_time - b.start_time);
    }
  }

  async reload(): Promise<void> {
    if (this.loading) return;
    const token = this.plugin.getToken();
    if (!token) {
      this.setStatus("로그인되지 않았습니다. 설정에서 'Plaud 로그인'을 해주세요.");
      this.recordings = [];
      this.applyFilter();
      return;
    }
    this.loading = true;
    this.setStatus("녹음 목록 불러오는 중...");
    try {
      const list = await listRecordings(token);
      this.recordings = list;
      this.applySort();
      this.rebuildPlaudIdIndex();
      this.applyFilter();
    } catch (e) {
      const msg =
        e instanceof PlaudApiError || e instanceof PlaudAuthError
          ? e.message
          : "녹음 목록을 가져오지 못했습니다.";
      this.setStatus(`오류: ${msg}`);
    } finally {
      this.loading = false;
    }
  }

  private rebuildPlaudIdIndex(): void {
    const map = new Map<string, TFile>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(f);
      const id = cache?.frontmatter?.plaud_id;
      if (typeof id === "string" && id) map.set(id, f);
    }
    this.plaudIdIndex = map;
  }

  /** 모달에서 임포트 성공 시 사이드패널이 즉시 반영하도록 호출. */
  notifyImported(plaudId: string, file: TFile): void {
    this.plaudIdIndex.set(plaudId, file);
    this.renderList();
    this.updateBatchBadge();
  }

  private applyFilter(): void {
    const q = this.query;
    if (!q) {
      this.filtered = this.recordings;
    } else {
      this.filtered = this.recordings.filter((r) => {
        if (r.filename.toLowerCase().includes(q)) return true;
        if (r.keywords?.some((k) => k.toLowerCase().includes(q))) return true;
        return false;
      });
    }
    this.refreshStatus();
    this.renderList();
    this.updateBatchBadge();
  }

  private refreshStatus(): void {
    const total = this.recordings.length;
    if (this.query) {
      this.setStatus(`필터: ${this.filtered.length} / ${total}개`);
    } else {
      this.setStatus(`총 ${total}개`);
    }
  }

  private renderList(): void {
    const c = this.listContainer;
    if (!c) return;
    c.empty();

    if (this.filtered.length === 0) {
      const empty = c.createDiv();
      empty.style.padding = "1em";
      empty.style.color = "var(--text-muted)";
      empty.setText(this.query ? "검색 결과가 없습니다." : "녹음이 없습니다.");
      return;
    }

    for (const rec of this.filtered) {
      const card = c.createDiv({ cls: "a4p-plaud-card" });
      card.dataset.plaudId = rec.id;

      card.createDiv({ cls: "a4p-plaud-card-date", text: formatStartTime(rec.start_time) });
      card.createDiv({ cls: "a4p-plaud-card-name", text: rec.filename });

      if (rec.keywords && rec.keywords.length > 0) {
        const kws = card.createDiv({ cls: "a4p-plaud-card-keywords" });
        for (const kw of rec.keywords.slice(0, 5)) {
          kws.createSpan({ cls: "a4p-plaud-keyword", text: kw });
        }
      }

      const meta = card.createDiv({ cls: "a4p-plaud-card-meta" });
      meta.createSpan({ cls: "a4p-plaud-card-duration", text: formatDuration(rec.duration) });

      if (rec.is_trans) this.badge(meta, "전사", "trans");
      if (rec.is_summary) this.badge(meta, "요약", "summary");

      const existingFile = this.plaudIdIndex.get(rec.id);
      const actionBtn = meta.createEl("button", { cls: "a4p-plaud-card-action" });
      if (existingFile) {
        card.addClass("a4p-plaud-card-imported");
        actionBtn.addClass("mod-cta");
        actionBtn.setText("📄 노트 열기");
        actionBtn.title = existingFile.path;
        actionBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.app.workspace.getLeaf(false).openFile(existingFile);
        });
        // 보조 ⓘ — 상세 모달 (이름 변경·트랜스크립트 보기 진입점)
        const detailBtn = meta.createEl("button", { text: "ⓘ" });
        detailBtn.title = "상세 / 이름 변경";
        detailBtn.style.marginLeft = "4px";
        detailBtn.style.padding = "4px 9px";
        detailBtn.style.fontSize = "0.85em";
        detailBtn.style.borderRadius = "5px";
        detailBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.openDetail(rec);
        });
      } else {
        actionBtn.setText("📄 노트 보기");
        actionBtn.title = "트랜스크립트 미리보기 / 노트로 가져오기";
        actionBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.openDetail(rec);
        });
      }

      card.addEventListener("click", () => {
        this.setPlayerForId(rec.id);
      });
    }
    // 카드 재렌더 후 활성 노트 하이라이트 복원 (스크롤 없음)
    this.highlightedCardEl = null;
    const af = this.app.workspace.getActiveFile();
    const fm = af ? this.app.metadataCache.getFileCache(af)?.frontmatter : null;
    const id = typeof fm?.plaud_id === "string" ? fm.plaud_id : null;
    if (id) this.highlightCardForId(id, false);
  }

  private badge(parent: HTMLElement, text: string, kind: "trans" | "summary"): void {
    parent.createSpan({
      text,
      cls: `a4p-plaud-badge a4p-plaud-badge-${kind}`,
    });
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.setText(text);
  }

  private async openDetail(rec: PlaudRecording): Promise<void> {
    const token = this.plugin.getToken();
    if (!token) {
      new Notice("로그인되지 않았습니다.");
      return;
    }
    new PlaudDetailModal(this.app, this.plugin, rec, this).open();
  }
}

class PlaudDetailModal extends Modal {
  plugin: A4PPlaudPlugin;
  recording: PlaudRecording;
  parentView: PlaudListView | null;
  /** MarkdownRenderer 수명 관리용 */
  private mdComponent: Component | null = null;
  /** 재생 상태 라벨 갱신 타이머들 (onOpen 재호출·닫기 시 정리) */
  private labelTimers: number[] = [];

  constructor(
    app: PlaudListView["app"],
    plugin: A4PPlaudPlugin,
    recording: PlaudRecording,
    parentView: PlaudListView | null = null
  ) {
    super(app);
    this.plugin = plugin;
    this.recording = recording;
    this.parentView = parentView;
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.style.width = "min(800px, 90vw)";
    this.mdComponent?.unload();
    this.mdComponent = new Component();
    this.mdComponent.load();
    for (const t of this.labelTimers) window.clearInterval(t);
    this.labelTimers = [];

    contentEl.createEl("h3", { text: this.recording.filename });

    const meta = contentEl.createDiv();
    meta.style.color = "var(--text-muted)";
    meta.style.fontSize = "0.85em";
    meta.style.marginBottom = "1em";
    meta.setText(
      `${formatStartTime(this.recording.start_time)} · ${formatDuration(
        this.recording.duration
      )}`
    );

    const body = contentEl.createDiv();
    body.style.maxHeight = "60vh";
    body.style.overflowY = "auto";
    body.style.whiteSpace = "pre-wrap";
    body.style.lineHeight = "1.55";
    body.style.padding = "8px";
    body.style.background = "var(--background-secondary)";
    body.style.borderRadius = "6px";
    body.setText("불러오는 중...");

    const token = this.plugin.getToken();
    if (!token) {
      body.setText("로그인되지 않았습니다.");
      return;
    }

    try {
      const detail = await getRecordingDetail(token, this.recording.id);
      contentEl.empty();
      contentEl.createEl("h3", { text: detail.filename });
      const meta2 = contentEl.createDiv();
      meta2.style.color = "var(--text-muted)";
      meta2.style.fontSize = "0.85em";
      meta2.style.marginBottom = "1em";
      meta2.style.userSelect = "text";
      meta2.setText(
        `${formatStartTime(detail.start_time)} · ${formatDuration(detail.duration)} · id: ${detail.id}`
      );

      this.renderActions(contentEl, detail);

      if (detail.summary) {
        contentEl.createEl("h4", { text: "AI 요약" });
        const sum = contentEl.createDiv();
        sum.style.marginBottom = "1em";
        sum.style.userSelect = "text";
        sum.style.cursor = "text";
        sum.style.maxHeight = "40vh";
        sum.style.overflowY = "auto";
        sum.style.padding = "0 8px";
        if (this.mdComponent) {
          await MarkdownRenderer.render(this.app, detail.summary, sum, "", this.mdComponent);
        } else {
          sum.style.whiteSpace = "pre-wrap";
          sum.setText(detail.summary);
        }
      }

      // STT 영역: 전사 안 됐고 캐시도 없을 때 버튼, 캐시 있으면 결과 표시
      this.renderSttSection(contentEl, detail);

      contentEl.createEl("h4", { text: "트랜스크립트" });
      if (detail.segments && detail.segments.length > 0) {
        const hintRow = contentEl.createDiv();
        hintRow.style.display = "flex";
        hintRow.style.alignItems = "center";
        hintRow.style.gap = "8px";
        hintRow.style.marginBottom = "0.4em";

        const hint = hintRow.createSpan();
        hint.style.fontSize = "0.82em";
        hint.style.color = "var(--text-muted)";
        hint.setText("⏯ 시간을 클릭하면 해당 위치부터 재생합니다.");

        const pauseBtn = hintRow.createEl("button");
        pauseBtn.style.fontSize = "0.82em";
        pauseBtn.style.padding = "2px 10px";
        const refreshLabel = () => {
          pauseBtn.setText(this.parentView?.isAudioPlaying() ? "⏸ 일시정지" : "▶ 재생");
        };
        refreshLabel();
        pauseBtn.addEventListener("click", () => {
          const playing = this.parentView?.togglePlayPause() ?? false;
          pauseBtn.setText(playing ? "⏸ 일시정지" : "▶ 재생");
        });
        // 타임스탬프 클릭으로 재생이 시작돼도 라벨이 따라오도록 주기 갱신
        const labelTimer = window.setInterval(refreshLabel, 500);
        this.scope.register([], "Escape", () => window.clearInterval(labelTimer));
        this.labelTimers.push(labelTimer);
      }
      const tr = contentEl.createDiv();
      tr.style.maxHeight = "50vh";
      tr.style.overflowY = "auto";
      tr.style.whiteSpace = "pre-wrap";
      tr.style.lineHeight = "1.55";
      tr.style.padding = "8px";
      tr.style.background = "var(--background-secondary)";
      tr.style.borderRadius = "6px";
      tr.style.userSelect = "text";
      tr.style.cursor = "text";
      const cached = sttCache.get(detail.id);
      if (detail.segments && detail.segments.length > 0) {
        // 타임스탬프 클릭 → 사이드패널 플레이어가 그 위치부터 재생
        for (const seg of detail.segments) {
          const line = tr.createDiv();
          line.style.marginBottom = "0.35em";
          const ts = line.createSpan({
            text: `[${msToClock(seg.start_time)}]`,
            cls: "a4p-plaud-ts-link",
          });
          ts.title = "이 위치부터 재생";
          ts.addEventListener("click", () => {
            void this.parentView?.playAt(detail.id, seg.start_time / 1000);
          });
          const prefix = seg.speaker ? ` ${seg.speaker}: ` : " ";
          line.createSpan({ text: `${prefix}${seg.content}` });
        }
      } else {
        tr.setText(
          detail.transcript || (cached ? cached.text : "전사된 트랜스크립트가 없습니다.")
        );
      }
    } catch (e) {
      const msg =
        e instanceof PlaudApiError || e instanceof PlaudAuthError
          ? e.message
          : "상세 정보를 가져오지 못했습니다.";
      body.setText(`오류: ${msg}`);
    }
  }

  private renderActions(parent: HTMLElement, detail: PlaudRecordingDetail): void {
    const bar = parent.createDiv();
    bar.style.display = "flex";
    bar.style.gap = "8px";
    bar.style.marginBottom = "0.5em";

    const existing = findNoteByPlaudId(this.app, detail.id);
    if (existing) {
      const openBtn = bar.createEl("button", { text: "노트 열기" });
      openBtn.addClass("mod-cta");
      openBtn.addEventListener("click", () => {
        this.app.workspace.getLeaf(false).openFile(existing);
        this.close();
      });

      const info = bar.createSpan({ text: `이미 임포트됨: ${existing.path}` });
      info.style.fontSize = "0.85em";
      info.style.color = "var(--text-muted)";
      info.style.alignSelf = "center";
      return;
    }

    const importBtn = bar.createEl("button", { text: "노트로 가져오기" });
    importBtn.addClass("mod-cta");

    const tplRow = parent.createDiv();
    tplRow.style.display = "flex";
    tplRow.style.gap = "6px";
    tplRow.style.alignItems = "center";
    tplRow.style.marginBottom = "1em";
    tplRow.style.fontSize = "0.88em";

    const label = tplRow.createSpan({ text: "템플릿:" });
    label.style.color = "var(--text-muted)";

    const tplInput = tplRow.createEl("input", { type: "text" });
    tplInput.style.flex = "1";
    tplInput.placeholder = "비우면 내장 형식";
    tplInput.value = this.plugin.settings.templatePath;

    const browseBtn = tplRow.createEl("button", { text: "📁" });
    browseBtn.title = "vault에서 템플릿 선택";
    browseBtn.addEventListener("click", () => {
      new ModalMarkdownFileSuggester(this.app, (f) => {
        tplInput.value = f.path;
      }).open();
    });

    const clearBtn = tplRow.createEl("button", { text: "✕" });
    clearBtn.title = "템플릿 비우기 (내장 형식 사용)";
    clearBtn.addEventListener("click", () => {
      tplInput.value = "";
    });

    importBtn.addEventListener("click", async () => {
      importBtn.setAttr("disabled", "true");
      importBtn.setText("가져오는 중...");
      try {
        const region = "";
        const tplPath = tplInput.value.trim();
        // STT 결과가 캐시에 있으면 transcript 자리에 사용
        const stt = sttCache.get(detail.id);
        const effective: PlaudRecordingDetail =
          stt && !detail.transcript ? { ...detail, transcript: stt.text } : detail;
        const { file, existed } = await importRecording(
          this.app,
          effective,
          region,
          this.plugin.settings.importFolder,
          {
            templatePath: tplPath || undefined,
            stt: stt ?? undefined,
            autoBibleWikilink: this.plugin.settings.autoBibleWikilink,
          }
        );
        new Notice(existed ? "이미 임포트된 녹음입니다." : `노트 생성: ${file.path}`);
        this.parentView?.notifyImported(detail.id, file);
        await this.app.workspace.getLeaf(false).openFile(file);
        this.close();
      } catch (e) {
        new Notice(`임포트 실패: ${(e as Error).message ?? "unknown"}`);
        importBtn.removeAttribute("disabled");
        importBtn.setText("노트로 가져오기");
      }
    });
  }

  private renderSttSection(parent: HTMLElement, detail: PlaudRecordingDetail): void {
    if (detail.transcript) return; // Plaud가 이미 전사함

    const cached = sttCache.get(detail.id);
    const ongoing = sttInProgress.get(detail.id);

    parent.createEl("h4", { text: "🎤 외부 STT 전사" });
    const box = parent.createDiv();
    box.style.padding = "10px 12px";
    box.style.marginBottom = "1em";
    box.style.border = "1px solid var(--background-modifier-border)";
    box.style.borderRadius = "6px";

    if (cached) {
      const ok = box.createDiv({
        text: `✅ ${cached.provider} (${cached.model}) — ${cached.text.length}자 전사 완료`,
      });
      ok.style.fontSize = "0.9em";
      ok.style.color = "var(--text-success, var(--text-normal))";
      ok.style.marginBottom = "4px";
      const note = box.createDiv({
        text: "임포트 시 본문 트랜스크립트로 자동 사용됩니다.",
      });
      note.style.fontSize = "0.82em";
      note.style.color = "var(--text-muted)";
      return;
    }

    if (ongoing) {
      const live = box.createDiv({ text: ongoing });
      live.style.fontSize = "0.9em";
      // 200ms마다 sttInProgress 상태 폴링하여 UI 갱신
      const timer = window.setInterval(() => {
        const t = sttInProgress.get(detail.id);
        if (t) {
          live.setText(t);
          return;
        }
        // 완료 또는 실패 → 모달 재렌더
        window.clearInterval(timer);
        this.onOpen();
      }, 250);
      this.scope.register([], "Escape", () => {
        window.clearInterval(timer);
      });
      return;
    }

    const provider = this.plugin.settings.sttProvider;
    const max = STT_MAX_FILE_SIZE[provider];
    const sizeStr = detail.filesize
      ? `${(detail.filesize / 1024 / 1024).toFixed(1)} MB`
      : "크기 불명";
    const tooBig = !!detail.filesize && detail.filesize > max;
    const estHours = (detail.duration ?? 0) / 1000 / 3600;
    const estCost = estHours * STT_COST_PER_HOUR[provider];

    const info = box.createDiv();
    info.style.fontSize = "0.88em";
    info.style.marginBottom = "8px";
    info.innerHTML =
      `공급자: <b>${provider}</b> · 파일: ${sizeStr} · ` +
      `예상 비용: <b>$${estCost.toFixed(3)}</b> · ` +
      `최대: ${(max / 1024 / 1024).toFixed(0)} MB`;

    if (tooBig) {
      const warn = box.createDiv({
        text: `⚠️ 파일이 ${provider} 제한을 초과합니다. Groq로 전환하거나 외부 도구로 분할해 주세요.`,
      });
      warn.style.color = "var(--text-error)";
      warn.style.fontSize = "0.85em";
      return;
    }

    const hasKey =
      provider === "groq" ? !!this.plugin.getGroqKey() : !!this.plugin.getOpenaiKey();
    if (!hasKey) {
      const warn = box.createDiv({
        text: `⚠️ 설정에 ${provider} API 키를 먼저 입력해 주세요.`,
      });
      warn.style.color = "var(--text-error)";
      warn.style.fontSize = "0.85em";
      return;
    }

    const startBtn = box.createEl("button", { text: "🎤 외부 STT로 전사 시작" });
    startBtn.addClass("mod-cta");
    startBtn.addEventListener("click", () => void this.runStt(detail));
  }

  private async runStt(detail: PlaudRecordingDetail): Promise<void> {
    const token = this.plugin.getToken();
    if (!token) {
      new Notice("로그인되지 않았습니다.");
      return;
    }
    const start = Date.now();
    const setStatus = (s: string) => {
      sttInProgress.set(detail.id, s);
      this.plugin.setStatusBar(s);
    };
    setStatus("🎤 mp3 URL 요청 중...");
    // 진행 시간 갱신 타이머
    const tick = window.setInterval(() => {
      const cur = sttInProgress.get(detail.id);
      if (!cur) {
        window.clearInterval(tick);
        return;
      }
      const sec = ((Date.now() - start) / 1000).toFixed(1);
      // 단계 텍스트에 (Ns) 갱신
      const base = cur.replace(/\s*\([0-9.]+초\)\s*$/, "");
      setStatus(`${base} (${sec}초)`);
    }, 250);

    try {
      // 모달 재렌더로 진행 영역 표시 전환
      this.onOpen();

      const url = await getMp3Url(token, detail.id);
      if (!url) throw new SttError("DOWNLOAD_FAILED", "mp3 URL을 받지 못했습니다.");

      setStatus("🎤 mp3 다운로드 중...");
      const audio = await downloadMp3(url);

      setStatus("🎤 STT 서버에 업로드 + 전사 중...");
      const result = await transcribeAudio({
        provider: this.plugin.settings.sttProvider,
        groqKey: this.plugin.getGroqKey(),
        openaiKey: this.plugin.getOpenaiKey(),
        groqModel: this.plugin.settings.sttGroqModel,
        openaiModel: this.plugin.settings.sttOpenaiModel,
        language: this.plugin.settings.sttLanguage,
        audio,
        filename: `${detail.id}.mp3`,
        autoFallback: this.plugin.settings.sttAutoFallback,
      });

      sttCache.set(detail.id, result);
      new Notice(`✅ STT 전사 완료 (${result.provider}, ${result.text.length}자)`);
    } catch (e) {
      const msg = e instanceof SttError ? e.message : (e as Error).message ?? "알 수 없는 오류";
      new Notice(`STT 실패: ${msg}`);
    } finally {
      sttInProgress.delete(detail.id);
      this.plugin.setStatusBar("");
      window.clearInterval(tick);
      // 모달이 아직 열려있으면 갱신
      this.onOpen();
    }
  }

  onClose(): void {
    for (const t of this.labelTimers) window.clearInterval(t);
    this.labelTimers = [];
    this.mdComponent?.unload();
    this.mdComponent = null;
    this.contentEl.empty();
  }
}

class ModalMarkdownFileSuggester extends FuzzySuggestModal<TFile> {
  constructor(app: App, private onPick: (file: TFile) => void) {
    super(app);
    this.setPlaceholder("템플릿 .md 파일 검색");
  }
  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }
  getItemText(f: TFile): string {
    return f.path;
  }
  onChooseItem(f: TFile): void {
    this.onPick(f);
  }
}
