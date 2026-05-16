import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { PlaudSettingTab } from "./settings";
import { isTokenExpired, parseAndValidateToken } from "./auth";
import { getMp3Url, getRecordingDetail, getUserInfo, listRecordings } from "./api";
import { PLAUD_VIEW_TYPE, PlaudListView } from "./view";
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

  async onload(): Promise<void> {
    console.log("A4P Plaud loaded");
    await this.loadSettings();
    await this.restoreSession();
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

    this.registerDebugCommands();
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

  private registerDebugCommands(): void {
    this.addCommand({
      id: "plaud-debug-list",
      name: "[debug] Plaud: 녹음 목록 조회 (콘솔 출력)",
      callback: async () => {
        if (!this.token) {
          new Notice("먼저 설정에서 로그인해 주세요.");
          return;
        }
        try {
          const list = await listRecordings(this.token);
          console.log(`[A4P Plaud] listRecordings → ${list.length}개`, list);
          new Notice(`녹음 ${list.length}개 (콘솔 확인)`);
        } catch (e) {
          console.error("[A4P Plaud] listRecordings error", e);
          new Notice(`오류: ${(e as Error).message ?? "unknown"}`);
        }
      },
    });

    this.addCommand({
      id: "plaud-debug-detail",
      name: "[debug] Plaud: 첫 녹음 상세 (콘솔 출력)",
      callback: async () => {
        if (!this.token) {
          new Notice("먼저 설정에서 로그인해 주세요.");
          return;
        }
        try {
          const list = await listRecordings(this.token);
          if (list.length === 0) {
            new Notice("녹음이 없습니다.");
            return;
          }
          const detail = await getRecordingDetail(this.token, list[0].id);
          console.log("[A4P Plaud] getRecordingDetail", detail);
          new Notice(
            `첫 녹음 상세 (콘솔 확인) — 트랜스크립트 길이: ${detail.transcript.length}자`
          );
        } catch (e) {
          console.error("[A4P Plaud] getRecordingDetail error", e);
          new Notice(`오류: ${(e as Error).message ?? "unknown"}`);
        }
      },
    });

    this.addCommand({
      id: "plaud-debug-mp3",
      name: "[debug] Plaud: 첫 녹음 mp3 URL",
      callback: async () => {
        if (!this.token) {
          new Notice("먼저 설정에서 로그인해 주세요.");
          return;
        }
        try {
          const list = await listRecordings(this.token);
          if (list.length === 0) {
            new Notice("녹음이 없습니다.");
            return;
          }
          const url = await getMp3Url(this.token, list[0].id);
          console.log("[A4P Plaud] getMp3Url", url);
          new Notice(url ? "mp3 URL 받음 (콘솔 확인)" : "mp3 URL을 받지 못했습니다.");
        } catch (e) {
          console.error("[A4P Plaud] getMp3Url error", e);
          new Notice(`오류: ${(e as Error).message ?? "unknown"}`);
        }
      },
    });
  }

  private async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  private async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
}
