import {
  App,
  FuzzySuggestModal,
  Notice,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";
import { promises as fsPromises } from "fs";
import type A4PPlaudPlugin from "./main";
import { FolderSuggest } from "./folder-suggest";
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

  /** 폴더 경로 검증: 존재 여부와 내부 항목 수(md 노트 또는 전체 파일)를 Notice로 알린다. */
  private verifyFolder(path: string, kind: "md" | "all"): void {
    const trimmed = path.trim().replace(/\/+$/, "");
    if (!trimmed) {
      new Notice("경로가 비어 있습니다.");
      return;
    }
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(trimmed));
    if (!(folder instanceof TFolder)) {
      new Notice(`⚠️ 폴더가 없습니다: ${trimmed}`);
      return;
    }
    const count = (f: TFolder): number => {
      let n = 0;
      for (const child of f.children) {
        if (child instanceof TFolder) n += count(child);
        else if (child instanceof TFile && (kind === "all" || child.extension === "md")) n++;
      }
      return n;
    };
    const label = kind === "md" ? "노트" : "파일";
    new Notice(`✅ 폴더 확인: ${label} ${count(folder)}개`);
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
      .addText((t) => {
        new FolderSuggest(this.app, t.inputEl);
        t.setPlaceholder("폴더를 선택하세요")
          .setValue(this.plugin.settings.importFolder)
          .onChange(async (v) => {
            this.plugin.settings.importFolder = v.trim().replace(/\/+$/, "");
            await this.plugin.persistSettings();
          });
      })
      .addButton((b) =>
        b.setButtonText("검증").onClick(() => {
          this.verifyFolder(this.plugin.settings.importFolder, "md");
        })
      );

    const tplSetting = new Setting(containerEl)
      .setName("기본 임포트 템플릿")
      .setDesc(
        "vault 내 .md 파일 경로. 비워두면 내장 형식을 사용합니다. " +
          "지원 변수: {{plaud_id}} {{transcript}} {{summary}} {{filename}} {{date}} {{duration}} {{duration_seconds}} {{serial_number}} {{keywords}} {{region}} {{imported_at}}. " +
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

    new Setting(containerEl)
      .setName("오디오 저장 폴더")
      .setDesc(
        "상세 모달의 '🔊 오디오 저장'이 mp3를 내려받을 vault 폴더. 비워두면 \"{저장 폴더}/audio\"를 사용합니다."
      )
      .addText((t) => {
        new FolderSuggest(this.app, t.inputEl);
        t.setPlaceholder("폴더를 선택하세요")
          .setValue(this.plugin.settings.audioFolder)
          .onChange(async (v) => {
            this.plugin.settings.audioFolder = v.trim().replace(/\/+$/, "");
            await this.plugin.persistSettings();
          });
      })
      .addButton((b) =>
        b.setButtonText("검증").onClick(() => {
          this.verifyFolder(this.plugin.settings.audioFolder, "all");
        })
      );

    new Setting(containerEl)
      .setName("새 녹음 자동 감지")
      .setDesc("주기적으로 Plaud 서버를 확인해 새 녹음이 오면 알림을 띄웁니다.")
      .addDropdown((d) =>
        d
          .addOption("0", "끔")
          .addOption("10", "10분마다")
          .addOption("30", "30분마다")
          .addOption("60", "1시간마다")
          .setValue(String(this.plugin.settings.autoCheckMinutes))
          .onChange(async (v) => {
            this.plugin.settings.autoCheckMinutes = Number(v) || 0;
            await this.plugin.persistSettings();
            this.plugin.setupAutoCheck();
          })
      );

    this.renderSttSection(containerEl);
    this.renderWatchSection(containerEl);
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

    new Setting(el)
      .setName("임포트 시 자동 STT")
      .setDesc(
        "Plaud 전사가 없는 녹음을 노트로 가져올 때 외부 STT를 자동 실행합니다. " +
          "(일괄 임포트에도 적용 — 녹음이 많으면 시간·비용이 늘어납니다)"
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoSttOnImport).onChange(async (v) => {
          this.plugin.settings.autoSttOnImport = v;
          await this.plugin.persistSettings();
        })
      );
  }

  // ─────────────────────────────────────────── 감시 폴더 자동 업로드

  private renderWatchSection(el: HTMLElement): void {
    el.createEl("h3", { text: "🎙 감시 폴더 자동 업로드 (실험 기능)" });

    const intro = el.createDiv();
    intro.style.padding = "0.7em 1em";
    intro.style.background = "var(--background-secondary)";
    intro.style.borderRadius = "6px";
    intro.style.marginBottom = "0.8em";
    intro.style.fontSize = "0.88em";
    intro.style.lineHeight = "1.55";
    const p1 = intro.createEl("p");
    p1.style.margin = "0 0 0.5em 0";
    p1.setText(
      "지정한 폴더에 녹음 파일(mp3·opus)을 넣으면 자동으로 내 Plaud 계정에 올리고, " +
        "Plaud가 전사·요약을 마치면 노트로 가져옵니다. 아이클라우드 드라이브 폴더를 지정하면 " +
        "아이폰에서 파일을 넣어도 이 컴퓨터의 옵시디언이 처리합니다."
    );
    const warn = intro.createEl("p");
    warn.style.margin = "0";
    warn.style.color = "var(--text-muted)";
    warn.setText(
      "⚠️ 이 기능은 Plaud 웹앱이 쓰는 비공식 연결을 사용합니다. 전사 실행 시 요금제의 전사 시간이 " +
        "차감되며, Plaud 측 변경으로 예고 없이 중단될 수 있습니다 (플러그인의 다른 기능에는 영향 없음). " +
        "원본 파일은 절대 이동·삭제하지 않습니다."
    );

    this.renderWebAccount(el);

    new Setting(el)
      .setName("감시 폴더 기능 켜기")
      .setDesc("끄면 감시·업로드가 모두 중단됩니다 (처리 기록은 보존).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.watchEnabled).onChange(async (v) => {
          this.plugin.settings.watchEnabled = v;
          await this.plugin.persistSettings();
          this.plugin.watcher?.start();
        })
      );

    new Setting(el)
      .setName("Vault 안 감시 폴더")
      .setDesc("이 vault 폴더(최상위 파일만)에 mp3/opus를 넣으면 자동 업로드합니다. 비우면 미사용.")
      .addText((t) => {
        new FolderSuggest(this.app, t.inputEl);
        t.setPlaceholder("폴더를 선택하세요")
          .setValue(this.plugin.settings.watchVaultFolder)
          .onChange(async (v) => {
            this.plugin.settings.watchVaultFolder = v.trim().replace(/\/+$/, "");
            await this.plugin.persistSettings();
            this.plugin.watcher?.start();
          });
      })
      .addButton((b) =>
        b.setButtonText("검증").onClick(() => {
          this.verifyFolder(this.plugin.settings.watchVaultFolder, "all");
        })
      );

    new Setting(el)
      .setName("Vault 밖 감시 폴더 (절대경로)")
      .setDesc(
        "아이클라우드 드라이브 등 vault 밖 폴더. 예: /Users/이름/Library/Mobile Documents/com~apple~CloudDocs/Plaud업로드"
      )
      .addText((t) =>
        t
          .setPlaceholder("/Users/.../Plaud업로드")
          .setValue(this.plugin.settings.watchExternalFolder)
          .onChange(async (v) => {
            this.plugin.settings.watchExternalFolder = v.trim().replace(/\/+$/, "");
            await this.plugin.persistSettings();
            this.plugin.watcher?.start();
          })
      )
      .addButton((b) =>
        b.setButtonText("검증").onClick(() => void this.verifyExternalFolder())
      );

    new Setting(el)
      .setName("확인 주기")
      .setDesc("vault 밖 폴더를 확인하는 주기 (vault 안은 즉시 감지)")
      .addDropdown((d) =>
        d
          .addOption("30", "30초마다")
          .addOption("60", "1분마다")
          .addOption("300", "5분마다")
          .setValue(String(this.plugin.settings.watchPollSeconds || 60))
          .onChange(async (v) => {
            this.plugin.settings.watchPollSeconds = Number(v) || 60;
            await this.plugin.persistSettings();
            this.plugin.watcher?.start();
          })
      );

    new Setting(el)
      .setName("전사 언어")
      .setDesc("Plaud 전사에 사용할 언어 (예: ko, en). 비우면 자동 감지.")
      .addText((t) =>
        t
          .setPlaceholder("ko")
          .setValue(this.plugin.settings.watchLanguage)
          .onChange(async (v) => {
            this.plugin.settings.watchLanguage = v.trim();
            await this.plugin.persistSettings();
          })
      );

    new Setting(el)
      .setName("전사 완료 시 자동 노트 임포트")
      .setDesc("끄면 업로드·전사까지만 하고, 노트는 사이드패널에서 직접 가져옵니다.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.watchAutoImport).onChange(async (v) => {
          this.plugin.settings.watchAutoImport = v;
          await this.plugin.persistSettings();
        })
      );

    const summary = this.plugin.watcher?.getQueueSummary();
    new Setting(el)
      .setName("처리 현황")
      .setDesc(
        summary
          ? `완료 ${summary.done}개 · 대기 ${summary.pending}개 · 업로드 중 ${summary.uploading}개 · 전사 중 ${summary.analyzing}개 · 실패 ${summary.errors}개`
          : "아직 처리 기록이 없습니다."
      )
      .addButton((b) =>
        b.setButtonText("미리보기 (dry-run)").onClick(async () => {
          const items = (await this.plugin.watcher?.preview()) ?? [];
          if (items.length === 0) {
            new Notice("감시 폴더에 대상 파일이 없습니다.");
            return;
          }
          const fresh = items.filter((i) => i.reason === "신규");
          const lines = items.slice(0, 12).map((i) => `${i.reason}: ${i.path}`);
          new Notice(
            `업로드 대상 ${fresh.length}개 / 전체 ${items.length}개\n` +
              lines.join("\n") +
              (items.length > 12 ? `\n... 외 ${items.length - 12}개` : ""),
            12000
          );
          console.log("[A4P Plaud] 감시 폴더 미리보기", items);
        })
      )
      .addButton((b) =>
        b.setButtonText("실패 재시도").onClick(async () => {
          await this.plugin.watcher?.retryErrors();
          this.display();
        })
      );
  }

  private renderWebAccount(el: HTMLElement): void {
    if (this.plugin.hasWebAuth()) {
      const box = el.createDiv();
      box.style.padding = "0.6em 1em";
      box.style.background = "var(--background-secondary)";
      box.style.borderRadius = "6px";
      box.style.marginBottom = "0.6em";
      const creds = this.plugin.getWebCreds();
      box.createEl("p", {
        text: `🔗 Plaud 웹 계정 연결됨${creds?.email ? `: ${creds.email}` : " (붙여넣은 토큰)"}`,
      }).style.margin = "0.2em 0";
      box.createEl("p", {
        text: creds
          ? "토큰 만료 시(약 30일) 저장된 자격증명으로 자동 재로그인합니다."
          : "토큰이 만료되면(약 30일) 새 토큰을 다시 붙여넣어야 합니다.",
      }).style.margin = "0.2em 0";

      new Setting(el)
        .setName("웹 계정 연결 해제")
        .setDesc("저장된 웹 토큰·자격증명을 삭제합니다. (공식 로그인과는 별개)")
        .addButton((b) =>
          b
            .setButtonText("연결 해제")
            .setWarning()
            .onClick(async () => {
              await this.plugin.webLogout();
              new Notice("Plaud 웹 계정 연결이 해제되었습니다.");
              this.display();
            })
        );
      return;
    }

    const guide = el.createDiv();
    guide.style.padding = "0.6em 1em";
    guide.style.border = "1px solid var(--background-modifier-border)";
    guide.style.borderRadius = "6px";
    guide.style.marginBottom = "0.6em";
    guide.style.fontSize = "0.88em";
    guide.style.lineHeight = "1.55";
    guide.setText(
      "업로드에는 Plaud 웹 계정 연결이 필요합니다 (위의 공식 로그인과 별개). " +
        "이메일/비밀번호는 OS 키체인으로 암호화 저장되며 토큰 만료 시 자동 재로그인에만 사용됩니다. " +
        "⚠️ 로그인 시 다른 기기의 Plaud 웹 세션이 로그아웃될 수 있습니다."
    );

    let email = "";
    let password = "";
    new Setting(el)
      .setName("Plaud 웹 계정")
      .setDesc("Plaud 이메일 계정으로 연결 (구글·Apple 로그인 계정은 아래 토큰 붙여넣기 사용)")
      .addText((t) => {
        t.setPlaceholder("이메일");
        t.onChange((v) => (email = v.trim()));
      })
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("비밀번호");
        t.onChange((v) => (password = v));
      })
      .addButton((b) =>
        b
          .setButtonText("연결")
          .setCta()
          .onClick(async () => {
            if (!email || !password) {
              new Notice("이메일과 비밀번호를 입력해 주세요.");
              return;
            }
            b.setDisabled(true).setButtonText("연결 중...");
            try {
              await this.plugin.webLoginWithCreds(email, password);
              new Notice("✅ Plaud 웹 계정이 연결되었습니다.");
              this.display();
            } catch (e) {
              new Notice(this.errMsg(e));
              b.setDisabled(false).setButtonText("연결");
            }
          })
      );

    new Setting(el)
      .setName("토큰 직접 붙여넣기 (고급)")
      .setDesc(
        "비밀번호 저장을 원치 않으면: web.plaud.ai 로그인 → 개발자 도구(Cmd+Opt+I) → " +
          "Console에 localStorage.getItem(\"tokenstr\") 입력 → 결과를 붙여넣으세요."
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("eyJ...");
        t.onChange(async (v) => {
          const jwt = v.trim().replace(/^"|"$/g, "");
          if (!jwt || jwt.length < 20) return;
          try {
            await this.plugin.webSetPastedToken(jwt);
            t.setValue("");
            new Notice("✅ 토큰이 저장되었습니다.");
            this.display();
          } catch (e) {
            new Notice(this.errMsg(e));
          }
        });
      });
  }

  private async verifyExternalFolder(): Promise<void> {
    const p = this.plugin.settings.watchExternalFolder.trim();
    if (!p) {
      new Notice("경로가 비어 있습니다.");
      return;
    }
    try {
      const st = await fsPromises.stat(p);
      if (!st.isDirectory()) {
        new Notice(`⚠️ 폴더가 아닙니다: ${p}`);
        return;
      }
      const names = await fsPromises.readdir(p);
      const audio = names.filter((n) => /\.(mp3|opus|asr)$/i.test(n)).length;
      const icloud = names.filter((n) => /^\..+\.icloud$/.test(n)).length;
      new Notice(
        `✅ 폴더 확인: 업로드 가능 오디오 ${audio}개${icloud ? ` · iCloud 미다운로드 ${icloud}개` : ""}`
      );
    } catch {
      new Notice(`⚠️ 폴더가 없거나 접근할 수 없습니다: ${p}`);
    }
  }

  private errMsg(e: unknown): string {
    if (e instanceof PlaudAuthError || e instanceof PlaudApiError) return e.message;
    return e instanceof Error ? e.message : "알 수 없는 오류가 발생했습니다.";
  }
}
