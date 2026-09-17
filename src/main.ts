import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { PlaudSettingTab } from "./settings";
import { PlaudAuthError, isTokenExpired, isTokenNearExpiry } from "./auth";
import {
  getRecordingDetail,
  getUserInfo,
  listRecentRecordings,
  PlaudApiError,
  setReauthHandler,
} from "./api";
import { resyncRecording } from "./import";
import { createDigestNote } from "./digest";
import {
  buildAuthorizeUrl,
  createPkce,
  createState,
  exchangeCode,
  refreshAccessToken,
} from "./oauth";
import { closeCallbackServer, waitForOAuthCode } from "./callback";
import { PLAUD_VIEW_TYPE, PlaudListView } from "./view";
import { convertBibleRefsInNote } from "./bible";
import { decryptFromBase64, encryptToBase64, isEncryptionAvailable } from "./storage";
import { FolderWatcher } from "./watcher";
import {
  PLAUD_WEB_API_DEFAULT_BASE,
  PlaudWebApiError,
  WebSession,
  tokenDataFromJwt,
  webLogin,
} from "./webapi";
import {
  DEFAULT_SETTINGS,
  PlaudSettings,
  PlaudTokenData,
  PlaudUserInfo,
  WebTokenData,
} from "./types";

interface WebCreds {
  email: string;
  password: string;
}

interface LoginStatus {
  loggedIn: boolean;
  user?: PlaudUserInfo;
}

export default class A4PPlaudPlugin extends Plugin {
  settings: PlaudSettings = { ...DEFAULT_SETTINGS };
  private token: PlaudTokenData | null = null;
  private user: PlaudUserInfo | null = null;
  private statusBarEl: HTMLElement | null = null;
  private settingTab: PlaudSettingTab | null = null;
  /** 동시 401에도 토큰 갱신은 1회만 — single-flight 가드 */
  private reloginPromise: Promise<PlaudTokenData | null> | null = null;
  /** 로그인 진행 중 중복 시작 방지 */
  private loginInProgress = false;
  /** 새 녹음 자동 감지 타이머 (설정 변경 시 재설정) */
  private autoCheckTimer: number | null = null;
  /** 마지막으로 확인한 최신 녹음 시각 — 첫 폴링에서 기준선만 잡고 알리지 않음 */
  private lastSeenLatest = 0;
  /** 감시 폴더 자동 업로드 (비공식 웹 API) */
  watcher: FolderWatcher | null = null;
  /** 웹 토큰 메모리 캐시 — 요청마다 키체인 복호화 방지 */
  private webTokenCache: WebTokenData | null = null;
  /** 웹 재로그인 single-flight (세션 축출 최소화) */
  private webReloginPromise: Promise<WebTokenData | null> | null = null;

  async onload(): Promise<void> {
    console.debug("A4P Plaud loaded");
    await this.loadSettings();
    setReauthHandler(() => this.reLogin());
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
      id: "plaud-resync-all",
      name: "임포트된 모든 Plaud 노트 재동기화",
      callback: () => void this.resyncAllNotes(),
    });

    this.addCommand({
      id: "plaud-digest-7",
      name: "Plaud 다이제스트 노트 생성 (최근 7일)",
      callback: () => void this.createDigest(7),
    });

    this.addCommand({
      id: "plaud-digest-30",
      name: "Plaud 다이제스트 노트 생성 (최근 30일)",
      callback: () => void this.createDigest(30),
    });

    this.addCommand({
      id: "plaud-watch-scan-now",
      name: "감시 폴더 지금 스캔",
      callback: () => {
        if (!this.settings.watchEnabled) {
          new Notice("감시 폴더 기능이 꺼져 있습니다. 설정에서 켜 주세요.");
          return;
        }
        new Notice("감시 폴더 스캔 중...");
        void this.watcher?.scanNow("manual");
      },
    });

    this.addCommand({
      id: "plaud-watch-retry",
      name: "감시 폴더: 실패한 업로드 재시도",
      callback: () => void this.watcher?.retryErrors(),
    });

    this.setupAutoCheck();

    this.watcher = new FolderWatcher(this);
    // 초기 vault 인덱싱 완료 후 시작 (create 이벤트 폭주 방지)
    this.app.workspace.onLayoutReady(() => this.watcher?.start());

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

  private async createDigest(days: number): Promise<void> {
    if (!this.token) {
      new Notice("로그인되지 않았습니다.");
      return;
    }
    new Notice(`최근 ${days}일 다이제스트 생성 중... (녹음 수에 따라 시간이 걸립니다)`);
    try {
      const file = await createDigestNote(this.app, this, days);
      new Notice(`✅ 다이제스트 생성: ${file.path}`);
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (e) {
      console.error("[A4P Plaud] 다이제스트 실패", e);
      new Notice(`다이제스트 실패: ${(e as Error).message ?? "unknown"}`);
    }
  }

  private async resyncAllNotes(): Promise<void> {
    if (!this.token) {
      new Notice("로그인되지 않았습니다.");
      return;
    }
    const targets: { file: TFile; id: string }[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const id = this.app.metadataCache.getFileCache(f)?.frontmatter?.plaud_id;
      if (typeof id === "string" && id) targets.push({ file: f, id });
    }
    if (targets.length === 0) {
      new Notice("plaud_id가 있는 노트가 없습니다.");
      return;
    }
    if (
      !window.confirm(
        `임포트된 노트 ${targets.length}개를 서버 최신 요약/전사로 재동기화할까요?\n(직접 쓴 메모는 보존됩니다)`
      )
    ) {
      return;
    }
    let ok = 0;
    let fail = 0;
    try {
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        this.setStatusBar(`Plaud 재동기화 ${i + 1}/${targets.length}`);
        try {
          if (!this.token) throw new Error("로그인 세션이 끊어졌습니다.");
          const detail = await getRecordingDetail(this.token, t.id);
          await resyncRecording(this.app, detail, t.file, {
            autoBibleWikilink: this.settings.autoBibleWikilink,
          });
          ok++;
        } catch (e) {
          fail++;
          console.error("[A4P Plaud] 재동기화 실패", t.file.path, e);
        }
        // 서버 부하 완화
        await new Promise((r) => setTimeout(r, 300));
      }
    } finally {
      this.setStatusBar("");
    }
    new Notice(`재동기화 완료: 성공 ${ok}개${fail ? `, 실패 ${fail}개` : ""}`);
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
    closeCallbackServer();
    this.watcher?.stop();
    if (this.autoCheckTimer !== null) window.clearInterval(this.autoCheckTimer);
    console.debug("A4P Plaud unloaded");
  }

  /** 새 녹음 자동 감지 타이머 설정 (설정 변경 시 settings.ts가 재호출) */
  setupAutoCheck(): void {
    if (this.autoCheckTimer !== null) {
      window.clearInterval(this.autoCheckTimer);
      this.autoCheckTimer = null;
    }
    const min = this.settings.autoCheckMinutes;
    if (!min || min <= 0) return;
    this.autoCheckTimer = window.setInterval(
      () => void this.checkNewRecordings(),
      Math.max(5, min) * 60 * 1000
    );
    this.registerInterval(this.autoCheckTimer);
  }

  private async checkNewRecordings(): Promise<void> {
    if (!this.token) return;
    try {
      const list = await listRecentRecordings(this.token);
      const latest = list.reduce((m, r) => Math.max(m, r.start_time), 0);
      if (latest === 0) return;
      if (this.lastSeenLatest === 0) {
        // 첫 폴링 — 기준선만 설정
        this.lastSeenLatest = latest;
        return;
      }
      const fresh = list.filter((r) => r.start_time > this.lastSeenLatest);
      if (fresh.length === 0) return;
      this.lastSeenLatest = latest;
      const first = fresh[0].filename;
      new Notice(
        `🎙 새 Plaud 녹음 ${fresh.length}개 도착${first ? `: ${first}${fresh.length > 1 ? " 외" : ""}` : ""}`
      );
      this.reloadViews();
    } catch (e) {
      console.warn("[A4P Plaud] 새 녹음 확인 실패(다음 주기에 재시도)", e);
    }
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

  /** 설정에서 "Plaud 로그인" 버튼 → 브라우저 OAuth 시작 (loopback 콜백) */
  async startLogin(): Promise<void> {
    if (!isEncryptionAvailable()) {
      new Notice("이 시스템에서는 토큰을 안전하게 저장할 수 없어 로그인할 수 없습니다.");
      return;
    }
    if (this.loginInProgress) {
      new Notice("이미 로그인이 진행 중입니다. 브라우저에서 로그인을 완료해 주세요.");
      return;
    }
    this.loginInProgress = true;
    try {
      const { verifier, challenge } = createPkce();
      const state = createState();
      // 콜백 서버를 먼저 열어 대기시킨 뒤 브라우저를 연다
      const codePromise = waitForOAuthCode(state);
      const url = buildAuthorizeUrl({ challenge, state });
      this.openExternal(url);
      new Notice("브라우저에서 Plaud 로그인(구글 로그인 그대로)을 완료해 주세요.");

      const code = await codePromise;
      const token = await exchangeCode({ code, verifier, state });
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
      this.loginInProgress = false;
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
        const token = await refreshAccessToken({ refreshToken: cur.refreshToken });
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
          // 구버전(mcp.plaud.ai) 토큰은 새 API에서 무효 — 세션을 정리하고 재로그인 안내
          if (e instanceof PlaudApiError && e.code === "UNAUTHORIZED") {
            this.token = null;
            this.settings.encryptedToken = null;
            await this.saveSettings();
            new Notice("플러그인 업데이트로 로그인 방식이 개선되었습니다. 설정에서 한 번만 다시 로그인해 주세요.");
            return;
          }
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
    // 서버측 revoke는 하지 않는다 — 공식 CLI/MCP와 client_id를 공유하므로
    // revoke 시 그쪽 세션까지 무효화될 수 있다. 로컬 토큰만 폐기.
    this.token = null;
    this.user = null;
    this.settings.encryptedToken = null;
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

  // ─────────────────────────────────────────── 비공식 웹 API 세션 (감시 폴더 업로드용)

  getWebToken(): WebTokenData | null {
    if (this.webTokenCache) return this.webTokenCache;
    if (!this.settings.encryptedWebToken || !isEncryptionAvailable()) return null;
    try {
      this.webTokenCache = JSON.parse(
        decryptFromBase64(this.settings.encryptedWebToken)
      ) as WebTokenData;
      return this.webTokenCache;
    } catch {
      return null;
    }
  }

  async setWebToken(t: WebTokenData | null): Promise<void> {
    this.webTokenCache = t;
    this.settings.encryptedWebToken = t ? encryptToBase64(JSON.stringify(t)) : null;
    await this.persistSettings();
  }

  getWebCreds(): WebCreds | null {
    if (!this.settings.encryptedWebCreds || !isEncryptionAvailable()) return null;
    try {
      return JSON.parse(decryptFromBase64(this.settings.encryptedWebCreds)) as WebCreds;
    } catch {
      return null;
    }
  }

  async setWebCreds(c: WebCreds | null): Promise<void> {
    this.settings.encryptedWebCreds = c ? encryptToBase64(JSON.stringify(c)) : null;
    await this.persistSettings();
  }

  hasWebAuth(): boolean {
    return !!this.getWebToken();
  }

  /** 설정 탭 "연결" 버튼 — 로그인 + 토큰·자격증명 저장 */
  async webLoginWithCreds(email: string, password: string): Promise<void> {
    const base = this.settings.webApiBase || PLAUD_WEB_API_DEFAULT_BASE;
    const token = await webLogin(base, email, password);
    await this.setWebToken(token);
    await this.setWebCreds({ email, password });
    this.watcher?.start();
  }

  /** 설정 탭 "토큰 직접 붙여넣기" — 비밀번호 저장을 원치 않는 사용자용 */
  async webSetPastedToken(jwt: string): Promise<void> {
    await this.setWebToken(tokenDataFromJwt(jwt.trim()));
    this.watcher?.start();
  }

  async webLogout(): Promise<void> {
    this.webTokenCache = null;
    this.settings.encryptedWebToken = null;
    this.settings.encryptedWebCreds = null;
    await this.persistSettings();
    this.watcher?.start(); // 인증 없음 → 내부에서 대기 상태로 전환
  }

  /**
   * 저장된 자격증명으로 재로그인 (single-flight).
   * ⚠️ Plaud는 새 로그인 시 오래된 세션을 축출할 수 있으므로 만료/401 시에만 호출된다.
   */
  private webRelogin(): Promise<WebTokenData | null> {
    if (this.webReloginPromise) return this.webReloginPromise;
    this.webReloginPromise = (async () => {
      const creds = this.getWebCreds();
      if (!creds) return null;
      try {
        const base = this.settings.webApiBase || PLAUD_WEB_API_DEFAULT_BASE;
        const token = await webLogin(base, creds.email, creds.password);
        await this.setWebToken(token);
        return token;
      } catch (e) {
        console.error("[A4P Plaud] 웹 재로그인 실패", e);
        return null;
      }
    })();
    return this.webReloginPromise.finally(() => {
      this.webReloginPromise = null;
    });
  }

  /** 감시 폴더 파이프라인이 쓰는 세션. 인증 정보가 없으면 null. */
  getWebSession(): WebSession | null {
    if (!this.hasWebAuth()) return null;
    return {
      getToken: async (forceRefresh?: boolean) => {
        const cur = this.getWebToken();
        const expiring = !cur || Date.now() > cur.expiresAt - 60_000;
        if (cur && !forceRefresh && !expiring) return cur.accessToken;
        const fresh = await this.webRelogin();
        if (fresh) return fresh.accessToken;
        // 재로그인 불가(자격증명 없음/실패) — 기존 토큰이라도 있으면 시도해 본다
        if (cur && !forceRefresh) return cur.accessToken;
        throw new PlaudWebApiError(
          "UNAUTHORIZED",
          "Plaud 웹 연결이 만료되었습니다. 설정에서 다시 연결해 주세요."
        );
      },
      getBase: () => this.settings.webApiBase || PLAUD_WEB_API_DEFAULT_BASE,
      setBase: async (url: string) => {
        this.settings.webApiBase = url;
        await this.persistSettings();
      },
    };
  }
}
