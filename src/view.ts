import { ItemView, Modal, Notice, WorkspaceLeaf } from "obsidian";
import type A4PPlaudPlugin from "./main";
import { getRecordingDetail, listRecordings, PlaudApiError } from "./api";
import { PlaudAuthError } from "./auth";
import { formatDuration, formatStartTime } from "./format";
import { PlaudRecording } from "./types";

export const PLAUD_VIEW_TYPE = "a4p-plaud-list-view";

export class PlaudListView extends ItemView {
  plugin: A4PPlaudPlugin;
  private recordings: PlaudRecording[] = [];
  private filtered: PlaudRecording[] = [];
  private query = "";
  private loading = false;
  private listContainer: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;

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

    const toolbar = root.createDiv({ cls: "a4p-plaud-toolbar" });
    toolbar.style.display = "flex";
    toolbar.style.gap = "6px";
    toolbar.style.padding = "8px";
    toolbar.style.borderBottom = "1px solid var(--background-modifier-border)";

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

    this.statusEl = root.createDiv({ cls: "a4p-plaud-status" });
    this.statusEl.style.padding = "8px";
    this.statusEl.style.fontSize = "0.85em";
    this.statusEl.style.color = "var(--text-muted)";

    this.listContainer = root.createDiv({ cls: "a4p-plaud-list" });
    this.listContainer.style.overflowY = "auto";
    this.listContainer.style.padding = "0 4px 8px 4px";

    await this.reload();
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
      list.sort((a, b) => b.start_time - a.start_time);
      this.recordings = list;
      this.setStatus(`총 ${list.length}개`);
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
    this.renderList();
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
      card.style.padding = "8px 10px";
      card.style.margin = "6px 0";
      card.style.borderRadius = "6px";
      card.style.background = "var(--background-secondary)";
      card.style.cursor = "pointer";

      const date = card.createDiv({ text: formatStartTime(rec.start_time) });
      date.style.fontSize = "0.85em";
      date.style.color = "var(--text-muted)";

      const name = card.createDiv({ text: rec.filename });
      name.style.fontWeight = "500";
      name.style.margin = "2px 0";
      name.style.overflow = "hidden";
      name.style.textOverflow = "ellipsis";
      name.style.whiteSpace = "nowrap";

      const meta = card.createDiv();
      meta.style.display = "flex";
      meta.style.gap = "6px";
      meta.style.alignItems = "center";
      meta.style.fontSize = "0.8em";

      const dur = meta.createSpan({ text: formatDuration(rec.duration) });
      dur.style.color = "var(--text-muted)";

      if (rec.is_trans) this.badge(meta, "전사");
      if (rec.is_summary) this.badge(meta, "요약");

      card.addEventListener("click", () => this.openDetail(rec));
      card.addEventListener("mouseenter", () => {
        card.style.background = "var(--background-modifier-hover)";
      });
      card.addEventListener("mouseleave", () => {
        card.style.background = "var(--background-secondary)";
      });
    }
  }

  private badge(parent: HTMLElement, text: string): void {
    const b = parent.createSpan({ text });
    b.style.padding = "1px 6px";
    b.style.borderRadius = "10px";
    b.style.background = "var(--background-modifier-border)";
    b.style.fontSize = "0.75em";
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
    new PlaudDetailModal(this.app, this.plugin, rec).open();
  }
}

class PlaudDetailModal extends Modal {
  plugin: A4PPlaudPlugin;
  recording: PlaudRecording;

  constructor(app: PlaudListView["app"], plugin: A4PPlaudPlugin, recording: PlaudRecording) {
    super(app);
    this.plugin = plugin;
    this.recording = recording;
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

  onClose(): void {
    this.contentEl.empty();
  }
}
