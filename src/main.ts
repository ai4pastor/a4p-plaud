import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { PlaudSettingTab } from "./settings";
import { isTokenExpired, parseAndValidateToken } from "./auth";
import { getUserInfo } from "./api";
import { PLAUD_VIEW_TYPE, PlaudListView } from "./view";
import { convertBibleRefsInNote } from "./bible";
import { decryptFromBase64, encryptToBase64, isEncryptionAvailable } from "./storage";
import {
  DEFAULT_SETTINGS,
  PlaudRegion,
  PlaudSettings,
  PlaudTokenData,
  PlaudUserInfo,
} from "./types";

interface LoginStatus {
  loggedIn: boolean;
  user?: PlaudUserInfo;
  region?: PlaudRegion;
}

export default class A4PPlaudPlugin extends Plugin {
  settings: PlaudSettings = { ...DEFAULT_SETTINGS };
  private token: PlaudTokenData | null = null;
  private user: PlaudUserInfo | null = null;
  private statusBarEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    console.log("A4P Plaud loaded");
    await this.loadSettings();
    await this.restoreSession();
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.style.display = "none";
    this.addSettingTab(new PlaudSettingTab(this.app, this));

    this.registerView(PLAUD_VIEW_TYPE, (leaf) => new PlaudListView(leaf, this));

    this.addRibbonIcon("microphone", "Plaud 패널 열기", () => {
      this.activateView();
    });

    this.addCommand({
      id: "plaud-open-view",
      name: "Plaud 패널 열기",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "plaud-bible-wikilink",
      name: "활성 노트의 성경 구절을 wikilink로 변환",
      callback: () => void this.convertActiveBibleRefs(),
    });
  }

  private async convertActiveBibleRefs(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || !(file instanceof TFile)) {
      new Notice("활성 노트가 없습니다.");
      return;
    }
    if (file.extension !== "md") {
      new Notice("마크다운 노트에서만 사용 가능합니다.");
      return;
    }
    try {
      const original = await this.app.vault.read(file);
      const { text, count } = convertBibleRefsInNote(original);
      if (count === 0) {
        new Notice("변환할 성경 구절을 찾지 못했습니다.");
        return;
      }
      if (text === original) {
        new Notice("변경할 내용이 없습니다.");
        return;
      }
      await this.app.vault.modify(file, text);
      new Notice(`성경 구절 ${count}개를 wikilink로 변환했습니다.`);
    } catch (e) {
      console.error("[A4P Plaud] 성경 wikilink 변환 실패", e);
      new Notice(`변환 실패: ${(e as Error).message ?? "unknown"}`);
    }
  }

  async onunload(): Promise<void> {
    console.log("A4P Plaud unloaded");
  }

  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(PLAUD_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: PLAUD_VIEW_TYPE, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
  }

  private async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  private async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async persistSettings(): Promise<void> {
    await this.saveSettings();
  }

  private async restoreSession(): Promise<void> {
    if (!this.settings.encryptedToken || !isEncryptionAvailable()) return;
    try {
      const json = decryptFromBase64(this.settings.encryptedToken);
      const token = JSON.parse(json) as PlaudTokenData;
      if (isTokenExpired(token)) {
        this.settings.encryptedToken = null;
        await this.saveSettings();
        return;
      }
      this.token = token;
      try {
        const { user, region } = await getUserInfo(token);
        this.user = user;
        if (region !== token.region) {
          this.token = { ...token, region };
          await this.persistToken(this.token);
        }
      } catch (e) {
        console.warn("Plaud: user info fetch failed on restore", e);
      }
    } catch (e) {
      console.error("Plaud: failed to restore session", e);
    }
  }

  async saveToken(rawToken: string): Promise<void> {
    const token = parseAndValidateToken(rawToken);
    const { user, region } = await getUserInfo(token);
    const finalToken: PlaudTokenData = { ...token, region };
    await this.persistToken(finalToken);
    this.token = finalToken;
    this.user = user;
  }

  async refreshUser(): Promise<void> {
    if (!this.token) throw new Error("로그인 상태가 아닙니다.");
    const { user, region } = await getUserInfo(this.token);
    this.user = user;
    if (region !== this.token.region) {
      this.token = { ...this.token, region };
      await this.persistToken(this.token);
    }
  }

  private async persistToken(token: PlaudTokenData): Promise<void> {
    this.settings.encryptedToken = encryptToBase64(JSON.stringify(token));
    await this.saveSettings();
  }

  async logout(): Promise<void> {
    this.token = null;
    this.user = null;
    this.settings.encryptedToken = null;
    await this.saveSettings();
  }

  getLoginStatus(): LoginStatus {
    return {
      loggedIn: !!this.token && !!this.user,
      user: this.user ?? undefined,
      region: this.token?.region,
    };
  }

  hasStoredToken(): boolean {
    return !!this.token;
  }

  getToken(): PlaudTokenData | null {
    return this.token;
  }

  getGroqKey(): string | null {
    if (!this.settings.encryptedGroqKey || !isEncryptionAvailable()) return null;
    try {
      return decryptFromBase64(this.settings.encryptedGroqKey);
    } catch {
      return null;
    }
  }

  getOpenaiKey(): string | null {
    if (!this.settings.encryptedOpenaiKey || !isEncryptionAvailable()) return null;
    try {
      return decryptFromBase64(this.settings.encryptedOpenaiKey);
    } catch {
      return null;
    }
  }

  async setGroqKey(plain: string | null): Promise<void> {
    this.settings.encryptedGroqKey = plain ? encryptToBase64(plain) : null;
    await this.saveSettings();
  }

  async setOpenaiKey(plain: string | null): Promise<void> {
    this.settings.encryptedOpenaiKey = plain ? encryptToBase64(plain) : null;
    await this.saveSettings();
  }

  setStatusBar(text: string): void {
    if (!this.statusBarEl) return;
    if (!text) {
      this.statusBarEl.style.display = "none";
      this.statusBarEl.setText("");
    } else {
      this.statusBarEl.style.display = "";
      this.statusBarEl.setText(text);
    }
  }
}
