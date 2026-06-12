import { Notice, ObsidianProtocolData, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { PlaudSettingTab } from "./settings";
import { PlaudAuthError, isTokenExpired, isTokenNearExpiry } from "./auth";
import { getRecordingDetail, getUserInfo } from "./api";
import { resyncRecording } from "./import";
import {
  buildAuthorizeUrl,
  createPkce,
  createState,
  exchangeCode,
  refreshAccessToken,
  registerClient,
} from "./oauth";
import { mcpListTools, resetMcpSession, setReauthHandler } from "./mcp";
import { PLAUD_VIEW_TYPE, PlaudListView } from "./view";
import { convertBibleRefsInNote } from "./bible";
import { decryptFromBase64, encryptToBase64, isEncryptionAvailable } from "./storage";
import {
  DEFAULT_SETTINGS,
  PlaudSettings,
  PlaudTokenData,
  PlaudUserInfo,
  PLAUD_OAUTH_PROTOCOL,
  PLAUD_OAUTH_REDIRECT,
} from "./types";

interface LoginStatus {
  loggedIn: boolean;
  user?: PlaudUserInfo;
}

interface PendingAuth {
  clientId: string;
  verifier: string;
  state: string;
}

export default class A4PPlaudPlugin extends Plugin {
  settings: PlaudSettings = { ...DEFAULT_SETTINGS };
  private token: PlaudTokenData | null = null;
  private user: PlaudUserInfo | null = null;
  private statusBarEl: HTMLElement | null = null;
  private settingTab: PlaudSettingTab | null = null;
  /** 동시 401에도 토큰 갱신은 1회만 — single-flight 가드 */
  private reloginPromise: Promise<PlaudTokenData | null> | null = null;
  /** OAuth 진행 중 임시 상태 (브라우저 콜백까지) */
  private pendingAuth: PendingAuth | null = null;

  async onload(): Promise<void> {
    console.log("A4P Plaud loaded");
    await this.loadSettings();
    setReauthHandler(() => this.reLogin());
    this.registerObsidianProtocolHandler(PLAUD_OAUTH_PROTOCOL, (params) => {
      void this.handleOAuthCallback(params);
    });
    await this.restoreSession();
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.style.display = "none";
    this.settingTab = new PlaudSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

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
      id: "plaud-login",
      name: "Plaud 로그인 (브라우저)",
      callback: () => void this.startLogin(),
    });

    this.addCommand({
      id: "plaud-bible-wikilink",
      name: "활성 노트의 성경 구절을 wikilink로 변환",
      callback: () => void this.convertActiveBibleRefs(),
    });

    this.addCommand({
      id: "plaud-resync-note",
      name: "현재 노트를 Plaud 최신 요약/전사로 갱신",
      callback: () => void this.resyncActiveNote(),
    });

    this.addCommand({
      id: "plaud-mcp-list-tools",
      name: "Plaud MCP 도구 목록 콘솔 출력 (디버그)",
      callback: () => void this.debugListTools(),
    });

    // 읽기 모드에서 plaud 노트의 [m:ss] 타임스탬프를 클릭 가능하게 — 클릭 시 그 위치 재생
    this.registerMarkdownPostProcessor((el, ctx) => {
      const fm = this.app.metadataCache.getCache(ctx.sourcePath)?.frontmatter;
      const plaudId = typeof fm?.plaud_id === "string" ? fm.plaud_id : null;
      if (!plaudId) return;
      this.linkifyTimestampsIn(el, plaudId);
    });
  }

  private linkifyTimestampsIn(root: HTMLElement, plaudId: string): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const targets: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const t = node as Text;
      if (!/\[\d{1,2}:\d{2}(?::\d{2})?\]/.test(t.data)) continue;
      // 코드 블록 안은 건드리지 않음
      if (t.parentElement?.closest("code, pre")) continue;
      targets.push(t);
    }
    for (const textNode of targets) {
      const re = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g;
      const data = textNode.data;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(data))) {
        frag.appendChild(document.createTextNode(data.slice(last, m.index)));
        const span = document.createElement("span");
        span.textContent = m[0];
        span.className = "a4p-plaud-ts-link";
        span.title = "이 위치부터 재생";
        const sec =
          m[3] !== undefined
            ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
            : Number(m[1]) * 60 + Number(m[2]);
        span.addEventListener("click", (ev) => {
          ev.preventDefault();
          void this.jumpToAudio(plaudId, sec);
        });
        frag.appendChild(span);
        last = m.index + m[0].length;
      }
      frag.appendChild(document.createTextNode(data.slice(last)));
      textNode.replaceWith(frag);
    }
  }

  private async jumpToAudio(plaudId: string, seconds: number): Promise<void> {
    await this.activateView();
    const leaf = this.app.workspace.getLeavesOfType(PLAUD_VIEW_TYPE)[0];
    const v = leaf?.view;
    if (v instanceof PlaudListView) {
      await v.playAt(plaudId, seconds);
    }
  }

  private async resyncActiveNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("활성 노트가 없습니다.");
      return;
    }
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const plaudId = typeof fm?.plaud_id === "string" ? fm.plaud_id : null;
    if (!plaudId) {
      new Notice("Plaud 노트가 아닙니다 (plaud_id frontmatter 없음).");
      return;
    }
    if (!this.token) {
      new Notice("로그인되지 않았습니다.");
      return;
    }
    new Notice("Plaud 서버에서 최신 요약/전사를 가져오는 중...");
    try {
      const detail = await getRecordingDetail(this.token, plaudId);
      const { mode } = await resyncRecording(this.app, detail, file, {
        autoBibleWikilink: this.settings.autoBibleWikilink,
      });
      new Notice(
        mode === "replaced"
          ? "✅ 노트 갱신 완료 (요약/전사 구간 교체)"
          : "✅ 갱신 완료 — 구버전 노트라 본문 끝에 최신 내용을 추가했습니다."
      );
    } catch (e) {
      console.error("[A4P Plaud] 노트 재동기화 실패", e);
      new Notice(`갱신 실패: ${(e as Error).message ?? "unknown"}`);
    }
  }

  private async debugListTools(): Promise<void> {
    if (!this.token) {
      new Notice("먼저 로그인해 주세요.");
      return;
    }
    try {
      await mcpListTools(this.token);
      new Notice("MCP 도구 목록을 콘솔(개발자 도구)에 출력했습니다.");
    } catch (e) {
      new Notice(`도구 목록 조회 실패: ${(e as Error).message ?? "unknown"}`);
    }
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
    setReauthHandler(null);
    resetMcpSession();
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

  // ─────────────────────────────────────────── OAuth 로그인 플로우

  /** 시스템 기본 브라우저로 URL 열기 (구글 로그인 세션 사용을 위해 내부 창 X) */
  private openExternal(url: string): void {
    try {
      const w = window as unknown as { require?: (m: string) => unknown };
      const req = w.require ?? (typeof require === "function" ? require : null);
      const electron = req?.("electron") as { shell?: { openExternal(u: string): void } } | undefined;
      if (electron?.shell?.openExternal) {
        electron.shell.openExternal(url);
        return;
      }
    } catch {
      // fall through
    }
    window.open(url, "_blank");
  }

  /** 설정에서 "Plaud 로그인" 버튼 → 브라우저 OAuth 시작 */
  async startLogin(): Promise<void> {
    if (!isEncryptionAvailable()) {
      new Notice("이 시스템에서는 토큰을 안전하게 저장할 수 없어 로그인할 수 없습니다.");
      return;
    }
    try {
      const redirectUri = PLAUD_OAUTH_REDIRECT;
      const clientId = await registerClient(redirectUri);
      const { verifier, challenge } = createPkce();
      const state = createState();
      this.pendingAuth = { clientId, verifier, state };
      const url = buildAuthorizeUrl({ clientId, redirectUri, challenge, state });
      this.openExternal(url);
      new Notice("브라우저에서 Plaud 로그인(구글 로그인 그대로)을 완료해 주세요.");
    } catch (e) {
      new Notice(this.authErr(e));
    }
  }

  private async handleOAuthCallback(params: ObsidianProtocolData): Promise<void> {
    const pending = this.pendingAuth;
    if (!pending) {
      new Notice("진행 중인 로그인 세션이 없습니다. 설정에서 다시 시도해 주세요.");
      return;
    }
    if (params.error) {
      this.pendingAuth = null;
      new Notice(`Plaud 로그인 거부: ${params.error_description ?? params.error}`);
      return;
    }
    if (!params.code) {
      new Notice("인증 코드를 받지 못했습니다. 다시 시도해 주세요.");
      return;
    }
    if (params.state !== pending.state) {
      this.pendingAuth = null;
      new Notice("로그인 상태 검증에 실패했습니다(보안). 다시 시도해 주세요.");
      return;
    }
    try {
      const token = await exchangeCode({
        code: params.code,
        verifier: pending.verifier,
        clientId: pending.clientId,
        redirectUri: PLAUD_OAUTH_REDIRECT,
      });
      resetMcpSession();
      await this.persistToken(token);
      this.token = token;
      try {
        const { user } = await getUserInfo(token);
        this.user = user;
        new Notice(`Plaud 로그인 완료: ${user.email || "(계정)"}`);
      } catch (e) {
        console.warn("[A4P Plaud] 로그인 직후 사용자 정보 조회 실패", e);
        new Notice("Plaud 로그인은 됐지만 사용자 정보를 가져오지 못했습니다.");
      }
      this.refreshSettingsTab();
      this.reloadViews();
    } catch (e) {
      new Notice(this.authErr(e));
    } finally {
      this.pendingAuth = null;
    }
  }

  /**
   * refresh token으로 access token 자동 갱신. 절대 throw하지 않고 실패 시 null.
   * 동시 401에도 1회만 실행(single-flight).
   */
  async reLogin(): Promise<PlaudTokenData | null> {
    if (this.reloginPromise) return this.reloginPromise;
    this.reloginPromise = (async () => {
      const cur = this.token;
      if (!cur || !cur.refreshToken) return null;
      try {
        const token = await refreshAccessToken({
          refreshToken: cur.refreshToken,
          clientId: cur.clientId,
        });
        resetMcpSession();
        await this.persistToken(token);
        this.token = token;
        return token;
      } catch (e) {
        console.error("[A4P Plaud] 토큰 갱신 실패", e);
        return null;
      }
    })();
    try {
      return await this.reloginPromise;
    } finally {
      this.reloginPromise = null;
    }
  }

  private async restoreSession(): Promise<void> {
    if (!this.settings.encryptedToken || !isEncryptionAvailable()) return;
    try {
      const token = JSON.parse(decryptFromBase64(this.settings.encryptedToken)) as PlaudTokenData;
      this.token = token;
      if (isTokenExpired(token) || isTokenNearExpiry(token)) {
        const fresh = await this.reLogin();
        if (!fresh && isTokenExpired(token)) {
          // 갱신 실패 + 이미 만료 → 세션 무효
          this.token = null;
          new Notice("Plaud 세션이 만료되었습니다. 설정에서 다시 로그인해 주세요.");
          return;
        }
      }
      if (this.token) {
        try {
          const { user } = await getUserInfo(this.token);
          this.user = user;
        } catch (e) {
          console.warn("[A4P Plaud] 세션 복원 중 사용자 정보 조회 실패", e);
        }
      }
    } catch (e) {
      console.error("[A4P Plaud] 세션 복원 실패", e);
    }
  }

  async refreshUser(): Promise<void> {
    if (!this.token) throw new Error("로그인 상태가 아닙니다.");
    const { user } = await getUserInfo(this.token);
    this.user = user;
  }

  private async persistToken(token: PlaudTokenData): Promise<void> {
    this.settings.encryptedToken = encryptToBase64(JSON.stringify(token));
    await this.saveSettings();
  }

  async logout(): Promise<void> {
    this.token = null;
    this.user = null;
    this.settings.encryptedToken = null;
    resetMcpSession();
    await this.saveSettings();
    this.reloadViews();
  }

  private refreshSettingsTab(): void {
    try {
      this.settingTab?.display();
    } catch {
      // 설정 탭이 화면에 없을 때 — 무시
    }
  }

  private reloadViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(PLAUD_VIEW_TYPE)) {
      const v = leaf.view;
      if (v instanceof PlaudListView) void v.reload();
    }
  }

  private authErr(e: unknown): string {
    if (e instanceof PlaudAuthError) return e.message;
    return e instanceof Error ? e.message : "알 수 없는 오류가 발생했습니다.";
  }

  getLoginStatus(): LoginStatus {
    return {
      loggedIn: !!this.token && !!this.user,
      user: this.user ?? undefined,
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
