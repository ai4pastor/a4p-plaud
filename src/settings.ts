import { App, FuzzySuggestModal, Notice, PluginSettingTab, Setting, TFile } from "obsidian";
import type A4PPlaudPlugin from "./main";
import { PlaudAuthError } from "./auth";
import { PlaudApiError } from "./api";
import { isEncryptionAvailable } from "./storage";
import { PlaudRegion, PlaudUserInfo, SttProvider } from "./types";

class MarkdownFileSuggester extends FuzzySuggestModal<TFile> {
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

    containerEl.createEl("h2", { text: "A4P plaud 설정" });

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

    const tplSetting = new Setting(containerEl)
      .setName("기본 임포트 템플릿")
      .setDesc(
        "vault 내 .md 파일 경로. 비워두면 내장 형식을 사용합니다. " +
          "지원 변수: {{plaud_id}} {{transcript}} {{summary}} {{filename}} {{date}} {{duration}} {{duration_seconds}} {{region}} {{imported_at}}. " +
          "Templater가 설치돼 있으면 <% ... %> 문법도 노트 생성 직후 자동 처리됩니다."
      );
    let tplTextRef: { setValue: (v: string) => void } | null = null;
    tplSetting.addText((t) => {
      tplTextRef = t as unknown as { setValue: (v: string) => void };
      t.setPlaceholder("templates/plaud-recording.md")
        .setValue(this.plugin.settings.templatePath)
        .onChange(async (v) => {
          this.plugin.settings.templatePath = v.trim();
          await this.plugin.persistSettings();
        });
    });
    tplSetting.addButton((b) =>
      b
        .setButtonText("📁 찾기")
        .onClick(() => {
          new MarkdownFileSuggester(this.app, async (f) => {
            this.plugin.settings.templatePath = f.path;
            await this.plugin.persistSettings();
            tplTextRef?.setValue(f.path);
          }).open();
        })
    );
    tplSetting.addButton((b) =>
      b
        .setButtonText("비우기")
        .onClick(async () => {
          this.plugin.settings.templatePath = "";
          await this.plugin.persistSettings();
          tplTextRef?.setValue("");
        })
    );

    this.renderSttSection(containerEl);
  }

  private renderSttSection(el: HTMLElement): void {
    el.createEl("h3", { text: "외부 STT 전사" });

    const intro = el.createDiv();
    intro.style.padding = "0.7em 1em";
    intro.style.background = "var(--background-secondary)";
    intro.style.borderRadius = "6px";
    intro.style.marginBottom = "0.8em";
    intro.style.fontSize = "0.88em";
    intro.style.lineHeight = "1.55";
    intro.setText(
      "Plaud에서 아직 전사되지 않은 녹음을 옵시디언 안에서 직접 전사할 수 있습니다. " +
        "Groq Whisper(500MB·무료 수준) 또는 OpenAI Whisper(25MB·유료)를 선택하세요. " +
        "키는 OS 키체인으로 암호화 저장됩니다."
    );

    new Setting(el)
      .setName("기본 공급자")
      .setDesc("STT 버튼을 누르면 사용할 기본 공급자")
      .addDropdown((d) =>
        d
          .addOption("groq", "Groq Whisper (추천)")
          .addOption("openai", "OpenAI Whisper")
          .setValue(this.plugin.settings.sttProvider)
          .onChange(async (v) => {
            this.plugin.settings.sttProvider = v as SttProvider;
            await this.plugin.persistSettings();
          })
      );

    // Groq 키
    new Setting(el)
      .setName("Groq API 키")
      .setDesc("https://console.groq.com 에서 발급. 저장 후 입력란은 비워집니다.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder(
          this.plugin.getGroqKey() ? "✓ 저장됨 (변경하려면 새 키 입력)" : "gsk_..."
        );
        t.onChange(async (v) => {
          const k = v.trim();
          if (!k) return;
          try {
            await this.plugin.setGroqKey(k);
            t.setValue("");
            t.setPlaceholder("✓ 저장됨 (변경하려면 새 키 입력)");
            new Notice("Groq 키 저장됨");
          } catch (e) {
            new Notice("Groq 키 저장 실패");
          }
        });
      })
      .addButton((b) =>
        b
          .setButtonText("삭제")
          .setWarning()
          .onClick(async () => {
            await this.plugin.setGroqKey(null);
            new Notice("Groq 키 삭제됨");
            this.display();
          })
      );

    // OpenAI 키
    new Setting(el)
      .setName("OpenAI API 키")
      .setDesc("https://platform.openai.com 에서 발급. 저장 후 입력란은 비워집니다.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder(
          this.plugin.getOpenaiKey() ? "✓ 저장됨 (변경하려면 새 키 입력)" : "sk-..."
        );
        t.onChange(async (v) => {
          const k = v.trim();
          if (!k) return;
          try {
            await this.plugin.setOpenaiKey(k);
            t.setValue("");
            t.setPlaceholder("✓ 저장됨 (변경하려면 새 키 입력)");
            new Notice("OpenAI 키 저장됨");
          } catch (e) {
            new Notice("OpenAI 키 저장 실패");
          }
        });
      })
      .addButton((b) =>
        b
          .setButtonText("삭제")
          .setWarning()
          .onClick(async () => {
            await this.plugin.setOpenaiKey(null);
            new Notice("OpenAI 키 삭제됨");
            this.display();
          })
      );

    new Setting(el)
      .setName("언어 (선택)")
      .setDesc("ISO 639-1 코드 (예: ko, en, ja). 빈 값이면 자동 감지.")
      .addText((t) =>
        t
          .setPlaceholder("ko")
          .setValue(this.plugin.settings.sttLanguage)
          .onChange(async (v) => {
            this.plugin.settings.sttLanguage = v.trim();
            await this.plugin.persistSettings();
          })
      );

    new Setting(el)
      .setName("Groq 모델")
      .setDesc("기본값: whisper-large-v3-turbo")
      .addText((t) =>
        t
          .setPlaceholder("whisper-large-v3-turbo")
          .setValue(this.plugin.settings.sttGroqModel)
          .onChange(async (v) => {
            this.plugin.settings.sttGroqModel = v.trim() || "whisper-large-v3-turbo";
            await this.plugin.persistSettings();
          })
      );

    new Setting(el)
      .setName("OpenAI 모델")
      .setDesc("기본값: whisper-1")
      .addText((t) =>
        t
          .setPlaceholder("whisper-1")
          .setValue(this.plugin.settings.sttOpenaiModel)
          .onChange(async (v) => {
            this.plugin.settings.sttOpenaiModel = v.trim() || "whisper-1";
            await this.plugin.persistSettings();
          })
      );

    new Setting(el)
      .setName("자동 폴백")
      .setDesc("기본 공급자가 실패하면 자동으로 다른 공급자로 재시도합니다.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.sttAutoFallback).onChange(async (v) => {
          this.plugin.settings.sttAutoFallback = v;
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
    guide.style.lineHeight = "1.6";
    guide.style.fontSize = "0.92em";

    guide.createEl("p", {
      text:
        "Plaud는 구글 로그인 등 OAuth만 지원해 옵시디언에서 직접 로그인할 수 없습니다. " +
        "Plaud 웹앱에서 발급된 access_token(JWT)을 한 번만 복사해 붙여넣으면 약 300일간 사용할 수 있습니다.",
    }).style.marginTop = "0";

    // ───────── 방법 A: Network 탭 (권장)
    const ha = guide.createEl("p", { text: "✅ 방법 A — Network 탭 (권장)" });
    ha.style.fontWeight = "600";
    ha.style.marginBottom = "0.2em";

    const olA = guide.createEl("ol");
    olA.style.paddingLeft = "1.3em";
    olA.style.margin = "0.2em 0 0.8em 0";
    const stepsA = [
      "브라우저로 https://app.plaud.ai 에 로그인 (구글 로그인 그대로 OK).",
      "개발자 도구 열기 — Mac: ⌘+⌥+I, Windows: F12. 상단에서 Network 탭으로 이동.",
      "Plaud 웹에서 아무 동작 (예: 녹음 목록 새로고침, 녹음 한 개 클릭). Network 패널에 요청들이 흐릅니다.",
      "요청 중 아무거나 하나 클릭 → 우측에 Headers 탭 → Request Headers 영역에서 'Authorization: Bearer ...' 줄을 찾습니다.",
      "'Bearer ' 다음의 매우 긴 문자열(보통 eyJ로 시작, 200자 이상) 전체를 복사. 끝부분에 공백/줄바꿈이 들어가지 않게 주의.",
      "아래 입력란에 붙여넣고 '저장 및 검증' 버튼.",
    ];
    for (const s of stepsA) olA.createEl("li", { text: s });

    // ───────── 방법 B: Application 탭 (대안)
    const hb = guide.createEl("p", { text: "🔁 방법 B — Application 탭 (대안)" });
    hb.style.fontWeight = "600";
    hb.style.marginBottom = "0.2em";

    const olB = guide.createEl("ol");
    olB.style.paddingLeft = "1.3em";
    olB.style.margin = "0.2em 0 0.8em 0";
    const stepsB = [
      "개발자 도구 → Application 탭 → 좌측 Storage → Local Storage → https://app.plaud.ai 선택.",
      "키 목록에서 'access_token' (또는 token / accessToken 비슷한 이름)을 찾아 값을 복사.",
      "값이 eyJ로 시작하는 긴 문자열이면 그대로 사용 가능. 아닐 경우 방법 A를 사용해 주세요.",
    ];
    for (const s of stepsB) olB.createEl("li", { text: s });

    // ───────── 리전 안내
    const hr = guide.createEl("p", { text: "🌍 리전(서버 위치) 안내" });
    hr.style.fontWeight = "600";
    hr.style.marginBottom = "0.2em";

    const pr = guide.createEl("p");
    pr.style.fontSize = "0.88em";
    pr.style.margin = "0 0 0.5em 0";
    pr.innerHTML =
      "Plaud는 사용자 위치에 따라 미국(US), 유럽(EU), 일본/아시아(APNE1) 등 여러 리전에 데이터가 저장됩니다. " +
      "본 플러그인은 토큰을 받은 뒤 자동으로 올바른 리전을 감지합니다(필요 시 한 번 자동 재시도). " +
      "검증 시 '<b>리전: APNE1</b>'처럼 표시되면 정상입니다.";

    const pr2 = guide.createEl("p");
    pr2.style.fontSize = "0.85em";
    pr2.style.margin = "0 0 0.6em 0";
    pr2.style.color = "var(--text-muted)";
    pr2.setText(
      "⚠️ '리전을 확인할 수 없습니다' 에러가 뜨면: ① 같은 브라우저에서 한 번 더 토큰을 받아 시도, " +
      "② VPN 사용 중이면 끄고 다시 시도, ③ 그래도 실패 시 개발자 콘솔(⌘+⌥+I)에서 '[A4P Plaud] -302 redirect' 로그를 복사해 이슈로 보고해 주세요."
    );

    // ───────── 보안 안내
    const ps = guide.createEl("p");
    ps.style.fontSize = "0.85em";
    ps.style.margin = "0";
    ps.style.color = "var(--text-muted)";
    ps.setText(
      "🔒 입력한 토큰은 macOS 키체인(safeStorage)으로 암호화되어 vault에 평문으로 저장되지 않습니다. " +
      "토큰 만료(약 300일 후) 시 같은 방법으로 새 토큰을 받아 다시 입력해 주세요."
    );

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
