import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type A4PPlaudPlugin from "./main";
import { PlaudAuthError } from "./auth";
import { PlaudApiError } from "./api";
import { isEncryptionAvailable } from "./storage";
import { PlaudRegion, PlaudUserInfo } from "./types";

export class PlaudSettingTab extends PluginSettingTab {
  plugin: A4PPlaudPlugin;
  private tokenInput = "";

  constructor(app: App, plugin: A4PPlaudPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Plaud (a4p) 설정" });

    if (!isEncryptionAvailable()) {
      const warn = containerEl.createDiv();
      warn.style.padding = "0.75em";
      warn.style.border = "1px solid var(--background-modifier-error)";
      warn.style.borderRadius = "6px";
      warn.style.marginBottom = "1em";
      warn.setText(
        "⚠️ 이 시스템에서는 비밀 저장소(safeStorage)를 사용할 수 없어 토큰을 안전하게 보관할 수 없습니다."
      );
      return;
    }

    const status = this.plugin.getLoginStatus();
    if (status.loggedIn && status.user && status.region) {
      this.renderLoggedIn(containerEl, status.user, status.region);
    } else if (this.plugin.hasStoredToken() && !status.user) {
      this.renderTokenButNoUser(containerEl);
    } else {
      this.renderTokenForm(containerEl);
    }

    containerEl.createEl("h3", { text: "임포트" });
    new Setting(containerEl)
      .setName("저장 폴더")
      .setDesc("Plaud 녹음을 노트로 가져올 때 사용할 vault 폴더입니다.")
      .addText((t) =>
        t
          .setPlaceholder("Plaud")
          .setValue(this.plugin.settings.importFolder)
          .onChange(async (v) => {
            this.plugin.settings.importFolder = v.trim() || "Plaud";
            await this.plugin.persistSettings();
          })
      );
  }

  private renderLoggedIn(el: HTMLElement, user: PlaudUserInfo, region: PlaudRegion): void {
    const box = el.createDiv();
    box.style.padding = "0.75em 1em";
    box.style.background = "var(--background-secondary)";
    box.style.borderRadius = "6px";
    box.style.marginBottom = "1em";
    box.createEl("p", { text: `로그인됨: ${user.email}` }).style.margin = "0.25em 0";
    if (user.nickname)
      box.createEl("p", { text: `닉네임: ${user.nickname}` }).style.margin = "0.25em 0";
    box.createEl("p", { text: `멤버십: ${user.membership_type}` }).style.margin = "0.25em 0";
    box.createEl("p", { text: `리전: ${region.toUpperCase()}` }).style.margin = "0.25em 0";

    new Setting(el)
      .setName("로그아웃")
      .setDesc("저장된 토큰을 삭제합니다. 다시 사용하려면 토큰 재입력이 필요합니다.")
      .addButton((btn) =>
        btn
          .setButtonText("로그아웃")
          .setWarning()
          .onClick(async () => {
            await this.plugin.logout();
            new Notice("로그아웃되었습니다.");
            this.display();
          })
      );
  }

  private renderTokenButNoUser(el: HTMLElement): void {
    const info = el.createDiv();
    info.style.padding = "0.75em 1em";
    info.style.border = "1px solid var(--background-modifier-border)";
    info.style.borderRadius = "6px";
    info.style.marginBottom = "1em";
    info.setText("저장된 토큰은 있지만 사용자 정보를 가져오지 못했습니다. 네트워크를 확인하거나 재시도해 주세요.");

    new Setting(el).addButton((btn) =>
      btn
        .setButtonText("재시도")
        .setCta()
        .onClick(async () => {
          btn.setDisabled(true).setButtonText("확인 중...");
          try {
            await this.plugin.refreshUser();
            this.display();
          } catch (e) {
            new Notice(this.errMsg(e));
            btn.setDisabled(false).setButtonText("재시도");
          }
        })
    );
    new Setting(el).addButton((btn) =>
      btn
        .setButtonText("로그아웃")
        .setWarning()
        .onClick(async () => {
          await this.plugin.logout();
          this.display();
        })
    );
  }

  private renderTokenForm(el: HTMLElement): void {
    const guide = el.createDiv();
    guide.style.padding = "0.9em 1em";
    guide.style.background = "var(--background-secondary)";
    guide.style.borderRadius = "6px";
    guide.style.marginBottom = "1em";
    guide.style.lineHeight = "1.55";
    guide.style.fontSize = "0.92em";

    guide.createEl("p", {
      text: "Plaud는 구글 로그인 등 OAuth만 지원해 옵시디언에서 직접 로그인할 수 없습니다. 아래 방법으로 access_token을 직접 가져와 주세요.",
    }).style.marginTop = "0";

    guide.createEl("p", { text: "Plaud 토큰 받는 법" }).style.fontWeight = "600";

    const ol = guide.createEl("ol");
    ol.style.paddingLeft = "1.2em";
    ol.style.margin = "0.3em 0 0.6em 0";
    const steps = [
      "Plaud 웹앱(app.plaud.ai)을 평소 방법(예: 구글 로그인)으로 엽니다.",
      "브라우저 개발자 도구를 엽니다 (Mac: Cmd+Opt+I, Windows: F12).",
      "Network 탭으로 이동한 뒤 Plaud 웹에서 아무 작업(예: 녹음 목록 새로고침)을 합니다.",
      "발생한 API 요청 하나를 클릭 → Headers → 'Authorization: Bearer …' 줄을 찾습니다.",
      "'Bearer ' 다음의 긴 문자열(보통 eyJ로 시작) 전체를 복사합니다.",
      "아래 입력란에 붙여넣고 '저장 및 검증' 버튼을 누릅니다.",
    ];
    for (const s of steps) ol.createEl("li", { text: s });

    guide.createEl("p", {
      text: "토큰은 약 300일간 유효합니다. 만료되면 같은 방법으로 새 토큰을 받아 주세요. 입력한 토큰은 운영체제 키체인(safeStorage)으로 암호화되어 보관됩니다.",
    }).style.fontSize = "0.88em";

    new Setting(el)
      .setName("Access Token")
      .setDesc("위에서 복사한 JWT를 붙여넣어 주세요.")
      .addTextArea((t) => {
        t.inputEl.rows = 4;
        t.inputEl.style.width = "100%";
        t.inputEl.style.fontFamily = "var(--font-monospace)";
        t.inputEl.style.fontSize = "0.85em";
        t.setPlaceholder("eyJhbGciOi...").onChange((v) => (this.tokenInput = v));
      });

    new Setting(el).addButton((btn) =>
      btn
        .setButtonText("저장 및 검증")
        .setCta()
        .onClick(async () => {
          if (!this.tokenInput.trim()) {
            new Notice("토큰을 입력해 주세요.");
            return;
          }
          btn.setDisabled(true).setButtonText("검증 중...");
          try {
            await this.plugin.saveToken(this.tokenInput);
            this.tokenInput = "";
            new Notice("토큰 검증 성공: 로그인됨");
            this.display();
          } catch (e) {
            new Notice(this.errMsg(e));
            btn.setDisabled(false).setButtonText("저장 및 검증");
          }
        })
    );
  }

  private errMsg(e: unknown): string {
    if (e instanceof PlaudAuthError || e instanceof PlaudApiError) return e.message;
    return "알 수 없는 오류가 발생했습니다.";
  }
}
