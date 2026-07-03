import { PlaudAuthError } from "./auth";
import { PLAUD_CALLBACK_PORT } from "./types";

/**
 * OAuth loopback 콜백 서버.
 * 공식 client의 redirect가 http://localhost:8199/auth/callback 로 고정돼 있어,
 * 로그인하는 동안에만 임시로 이 포트를 열어 인증 코드를 받는다.
 * 코드 수신·오류·타임아웃 즉시 서버를 닫는다.
 */

interface NodeHttpServer {
  listen(port: number, cb?: () => void): void;
  close(): void;
  on(event: string, cb: (err: { code?: string; message?: string }) => void): void;
}

interface NodeHttpRequest {
  url?: string;
  method?: string;
}

interface NodeHttpResponse {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

function nodeHttp(): { createServer(h: (req: NodeHttpRequest, res: NodeHttpResponse) => void): NodeHttpServer } {
  const w = window as unknown as { require?: (m: string) => unknown };
  const req = w.require ?? (typeof require === "function" ? require : null);
  if (!req) throw new PlaudAuthError("UNKNOWN", "이 환경에서는 로그인 콜백 서버를 열 수 없습니다.");
  return req("http") as ReturnType<typeof nodeHttp>;
}

const SUCCESS_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Plaud 로그인</title></head>' +
  '<body style="font-family:system-ui;padding:2rem;text-align:center;">' +
  "<h1>로그인 완료!</h1><p>이 탭을 닫고 Obsidian으로 돌아가세요.</p></body></html>";

function errorHtml(msg: string): string {
  const escaped = msg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>Plaud 로그인</title></head>' +
    '<body style="font-family:system-ui;padding:2rem;text-align:center;">' +
    `<h1>로그인 실패</h1><pre style="white-space:pre-wrap;">${escaped}</pre></body></html>`
  );
}

let activeServer: NodeHttpServer | null = null;

/** 이전 로그인 시도가 남아 있으면 닫는다 (재시도 대비). */
export function closeCallbackServer(): void {
  if (activeServer) {
    try {
      activeServer.close();
    } catch {
      // 이미 닫힘 — 무시
    }
    activeServer = null;
  }
}

/**
 * 콜백 서버를 열고 인증 코드를 기다린다.
 * 성공 시 code 반환, 오류/타임아웃/state 불일치 시 PlaudAuthError를 던진다.
 */
export function waitForOAuthCode(expectedState: string, timeoutMs = 5 * 60 * 1000): Promise<string> {
  closeCallbackServer();
  const http = nodeHttp();

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finalize = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // 응답 flush 후 닫기
      setTimeout(() => closeCallbackServer(), 1000);
      fn();
    };

    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", `http://localhost:${PLAUD_CALLBACK_PORT}`);
      if (reqUrl.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const params = reqUrl.searchParams;
      const error = params.get("error");
      const state = params.get("state");
      const code = params.get("code");

      if (error) {
        const desc = params.get("error_description") ?? error;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(errorHtml(desc));
        finalize(() => reject(new PlaudAuthError("OAUTH_FAILED", `Plaud 로그인 거부: ${desc}`)));
        return;
      }
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(errorHtml("인증 코드가 없습니다."));
        finalize(() => reject(new PlaudAuthError("OAUTH_FAILED", "인증 코드를 받지 못했습니다.")));
        return;
      }
      if (state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(errorHtml("state 검증 실패 — 다시 시도해 주세요."));
        finalize(() => reject(new PlaudAuthError("STATE_MISMATCH", "로그인 상태 검증에 실패했습니다(보안). 다시 시도해 주세요.")));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SUCCESS_HTML);
      finalize(() => resolve(code));
    });

    server.on("error", (err) => {
      const msg =
        err.code === "EADDRINUSE"
          ? `포트 ${PLAUD_CALLBACK_PORT}이 사용 중입니다. 다른 Plaud 로그인(공식 CLI 등)이 진행 중인지 확인하고 잠시 후 다시 시도해 주세요.`
          : `콜백 서버 오류: ${err.message ?? "unknown"}`;
      finalize(() => reject(new PlaudAuthError("OAUTH_FAILED", msg)));
    });

    timer = setTimeout(() => {
      finalize(() => reject(new PlaudAuthError("CANCELLED", "로그인 대기 시간이 초과됐습니다. 다시 시도해 주세요.")));
    }, timeoutMs);

    activeServer = server;
    server.listen(PLAUD_CALLBACK_PORT);
  });
}
