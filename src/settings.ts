import { App, FuzzySuggestModal, Notice, PluginSettingTab, Setting, TFile } from "obsidian";
import type A4PPlaudPlugin from "./main";
import { PlaudAuthError } from "./auth";
import { PlaudApiError } from "./api";
import { isEncryptionAvailable } from "./storage";
import { PlaudUserInfo, SttProvider } from "./types";

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
        "⚠️ 이 시스템에서는 비밀 저장소(safeStorage)를 사용할 수 없어 로그인 토큰을 안전하게 보관할 수 없습니다."
      );
      return;
    }

    const status = this.plugin.getLoginStatus();
    if (status.loggedIn && status.user) {
      this.renderLoggedIn(containerEl, status.user);
    } else if (this.plugin.hasStoredToken() && !status.user) {
      this.renderTokenButNoUser(containerEl);
    } else {
      this.renderLoginForm(containerEl);
    }

    containerEl.createEl("h3", { text: "임포트" });
    new Setting(containerEl)
      .setName("성경 구절 자동 wikilink")
      .setDesc("노트로 가져올 때 본문의 성경 구절(예: 요한복음 3:16)을 [[요3_16]] 형태로 자동 변환합니다.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoBibleWikilink).onChange(async (v) => {
          this.plugin.settings.autoBibleWikilink = v;
          await this.plugin.persistSettings();
        })
      );

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

  private renderLoginForm(el: HTMLElement): void {
    const guide = el.createDiv();
    guide.style.padding = "0.9em 1em";
    guide.style.background = "var(--background-secondary)";
    guide.style.borderRadius = "6px";
    guide.style.marginBottom = "1em";
    guide.style.lineHeight = "1.6";
    guide.style.fontSize = "0.92em";

    guide.createEl("p", {
      text:
        "아래 'Plaud 로그인' 버튼을 누르면 브라우저가 열립니다. 평소 쓰시던 방식(구글·Apple·이메일) 그대로 로그인하면 됩니다. " +
        "기존 녹음이 그대로 연결됩니다.",
    }).style.marginTop = "0";

    const p2 = guide.createEl("p");
    p2.style.margin = "0 0 0.5em 0";
    p2.innerHTML =
      "로그인 후에는 토큰이 <b>자동으로 갱신</b>되므로, 며칠마다 다시 로그인할 필요가 없습니다. " +
      "(공식 Plaud 연결 방식을 사용합니다.)";

    const sec = guide.createEl("p");
    sec.style.fontSize = "0.85em";
    sec.style.margin = "0";
    sec.style.color = "var(--text-muted)";
    sec.setText(
      "🔒 로그인 토큰은 OS 키체인(safeStorage)으로 암호화되어 vault에 평문으로 저장되지 않습니다. " +
        "비밀번호는 플러그인이 저장하지 않으며, 로그인은 브라우저에서만 이뤄집니다."
    );

    new Setting(el)
      .setName("Plaud 계정")
      .setDesc("브라우저로 안전하게 로그인 (OAuth)")
      .addButton((btn) =>
        btn
          .setButtonText("Plaud 로그인")
          .setCta()
          .onClick(() => void this.plugin.startLogin())
      );
  }

  private renderLoggedIn(el: HTMLElement, user: PlaudUserInfo): void {
    const box = el.createDiv();
    box.style.padding = "0.75em 1em";
    box.style.background = "var(--background-secondary)";
    box.style.borderRadius = "6px";
    box.style.marginBottom = "1em";
    box.createEl("p", { text: `로그인됨: ${user.email || "(계정)"}` }).style.margin = "0.25em 0";
    if (user.nickname)
      box.createEl("p", { text: `닉네임: ${user.nickname}` }).style.margin = "0.25em 0";
    if (user.membership_type && user.membership_type !== "unknown")
      box.createEl("p", { text: `멤버십: ${user.membership_type}` }).style.margin = "0.25em 0";
    box.createEl("p", {
      text: "자동 갱신: ✅ 사용 중 (토큰 만료 시 자동으로 재발급됩니다)",
    }).style.margin = "0.25em 0";

    new Setting(el)
      .setName("로그아웃")
      .setDesc("저장된 로그인 토큰을 삭제합니다. 다시 사용하려면 재로그인이 필요합니다.")
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
    info.setText(
      "로그인 토큰은 있지만 사용자 정보를 가져오지 못했습니다. 네트워크를 확인하거나 재시도해 주세요."
    );

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

  private errMsg(e: unknown): string {
    if (e instanceof PlaudAuthError || e instanceof PlaudApiError) return e.message;
    return e instanceof Error ? e.message : "알 수 없는 오류가 발생했습니다.";
  }
}
