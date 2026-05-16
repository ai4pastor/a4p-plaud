import { App, FuzzySuggestModal, ItemView, Modal, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type A4PPlaudPlugin from "./main";
import { getMp3Url, getRecordingDetail, listRecordings, PlaudApiError } from "./api";
import { PlaudAuthError } from "./auth";
import { formatDuration, formatStartTime } from "./format";
import { findNoteByPlaudId, importRecording } from "./import";
import { PlaudRecording, PlaudRecordingDetail } from "./types";

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

  private sortLabel(): string {
    return this.sortOrder === "desc" ? "↓ 최신순" : "↑ 오래된순";
  }

  private applySort(): void {
    const dir = this.sortOrder === "desc" ? -1 : 1;
    this.recordings.sort((a, b) => dir * (b.start_time - a.start_time));
  }

  async reload(): Promise<void> {
    if (this.loading) return;
    const token = this.plugin.getToken();
    if (!token) {
      this.setStatus("로그인되지 않았습니다. 설정에서 토큰을 입력해 주세요.");
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
      meta2.setText(
        `${formatStartTime(detail.start_time)} · ${formatDuration(detail.duration)} · id: ${detail.id}`
      );

      this.renderActions(contentEl, detail);

      if (detail.summary) {
        contentEl.createEl("h4", { text: "AI 요약" });
        const sum = contentEl.createDiv();
        sum.style.whiteSpace = "pre-wrap";
        sum.style.marginBottom = "1em";
        sum.setText(detail.summary);
      }

      contentEl.createEl("h4", { text: "트랜스크립트" });
      const tr = contentEl.createDiv();
      tr.style.maxHeight = "50vh";
      tr.style.overflowY = "auto";
      tr.style.whiteSpace = "pre-wrap";
      tr.style.lineHeight = "1.55";
      tr.style.padding = "8px";
      tr.style.background = "var(--background-secondary)";
      tr.style.borderRadius = "6px";
      tr.setText(detail.transcript || "전사된 트랜스크립트가 없습니다.");
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
        const token = this.plugin.getToken();
        const region = token?.region ?? "us";
        const tplPath = tplInput.value.trim();
        const { file, existed } = await importRecording(
          this.app,
          detail,
          region,
          this.plugin.settings.importFolder,
          { templatePath: tplPath || undefined }
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

  onClose(): void {
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
