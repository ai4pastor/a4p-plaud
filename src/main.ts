import { Plugin } from "obsidian";
import { PlaudSettingTab } from "./settings";
import { isTokenExpired, parseAndValidateToken } from "./auth";
import { getUserInfo } from "./api";
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
  }

  async onunload(): Promise<void> {
    console.log("A4P Plaud unloaded");
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
