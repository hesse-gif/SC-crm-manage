// 버그 제보 / 개선 의견 티켓 — 클라이언트 브리지.
// 출처: supercent-io/ticket-widget-skill assets/firebase-tickets.ts. 원본은 Firestore SDK 를 직접 썼지만
// Flu 는 클라 Firestore 접근이 전면 금지(SEC-P0-004)라 모든 읽기/쓰기를 callable 로 바꿨다.
// 이미지는 Storage 없이 data URL 로 문서에 그대로 담는다 — 문서 상한 1MB 안에 들어오도록 클라가 축소한다.
import { callFluCallable } from "./data";

export type TicketKind = "bug" | "idea";
export type TicketStatus = "open" | "done";
export type TicketSyncStatus = "pending" | "synced" | "failed" | "manual";

export interface TicketSuperboardSync {
  status: TicketSyncStatus;
  taskId: string | null;
  ticketKey: string | null;
  error: string | null;
}

export interface Ticket {
  id: string;
  kind: TicketKind;
  body: string;
  images: string[]; // data:image/jpeg;base64,... 배열
  logs: string | null; // 버그 티켓에만 — 제출 시점의 URL/UA + 최근 콘솔 error/warn 로그
  authorEmail: string;
  status: TicketStatus;
  createdAtMs: number | null;
  superboardSync: TicketSuperboardSync;
}

export const TICKET_MAX_BODY = 2000;
export const TICKET_MAX_IMAGES = 5;
// 장당 상한 — 5장이 문서 1MB 상한 안에 들어오도록 잡은 값(5 × 180KB = 900KB). 서버 검증과 동일.
export const TICKET_MAX_IMAGE = 180_000;
export const TICKET_MAX_LOGS = 20_000; // 서버 검증과 동일

// ─── 로그 자동수집 ────────────────────────────────────────────────────────────
// 버그 제보에 함께 담을 콘솔 로그 버퍼. 모듈 로드 시 console.error/warn을 감싸고
// uncaught error / unhandledrejection을 듣는다. 전송 상한을 넘으면 오래된 줄부터 버린다.
// console.log는 담지 않는다 — 노이즈가 많고 개인정보가 섞이기 쉽다.
// HMR·중복 import에도 한 번만 설치되도록 버퍼를 window에 둔다.
const logBox = (() => {
  if (typeof window === "undefined") return null; // SSR
  const w = window as unknown as { __ticketLogs?: { lines: string[] } };
  if (!w.__ticketLogs) {
    const lines: string[] = [];
    const fmt = (v: unknown): string => {
      if (v instanceof Error) return `${v.name}: ${v.message}`;
      if (typeof v === "string") return v;
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    };
    const push = (level: string, args: unknown[]) => {
      lines.push(`${new Date().toISOString()} [${level}] ${args.map(fmt).join(" ")}`.slice(0, 300));
      let total = 0;
      for (const l of lines) total += l.length + 1;
      while (total > TICKET_MAX_LOGS - 500 && lines.length > 1) total -= (lines.shift()?.length ?? 0) + 1;
    };
    for (const level of ["error", "warn"] as const) {
      const orig = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        push(level, args);
        orig(...args);
      };
    }
    // capture 단계 — 리소스 로드 실패(script/img/css 404 등)는 window로 버블되지 않는다.
    window.addEventListener(
      "error",
      (e) => {
        const t = e.target as (HTMLElement & { src?: string; href?: string }) | null;
        if (t && t !== (window as unknown as EventTarget) && (t.src || t.href)) {
          push("resource", [`로드 실패: ${t.src || t.href}`]);
        } else {
          push("uncaught", [e.message]);
        }
      },
      true,
    );
    window.addEventListener("unhandledrejection", (e) => push("unhandled", [e.reason]));
    // 페이지 이동 자취 — "어느 화면에서 났는가"를 서버·SuperBoard 가 로그만으로 알 수 있게.
    // Next.js App Router 는 pushState/replaceState 로 이동하므로 그 둘과 popstate 를 감싼다.
    const nav = () => push("nav", [`${location.pathname}${location.search}`]);
    nav();
    for (const method of ["pushState", "replaceState"] as const) {
      const orig = history[method].bind(history);
      history[method] = ((...args: Parameters<History["pushState"]>) => {
        const result = orig(...args);
        nav();
        return result;
      }) as History["pushState"];
    }
    window.addEventListener("popstate", nav);
    w.__ticketLogs = { lines };
  }
  return w.__ticketLogs;
})();

// 제출 시점 스냅샷 — 환경 정보(URL/제목/UA/뷰포트) 뒤에 최근 로그를 붙인다.
// 개선 의견(idea)은 콘솔 오류 없이 페이지 정보와 이동 자취만 담는다.
export const collectTicketLogs = (kind: TicketKind = "bug"): string => {
  if (!logBox) return "";
  const lines = kind === "bug" ? logBox.lines : logBox.lines.filter((l) => l.includes("[nav]"));
  return [
    `URL: ${location.href}`,
    `Title: ${document.title}`,
    `UA: ${navigator.userAgent}`,
    `Viewport: ${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`,
    `Time: ${new Date().toISOString()}`,
    "",
    ...lines,
  ].join("\n");
};

// 제보 등록. 실패는 호출부에서 사용자에게 알려야 하므로 throw한다.
export const submitTicket = async (
  kind: TicketKind,
  body: string,
  images: string[],
  logs: string | null,
): Promise<{ id: string; superboardSync: TicketSuperboardSync }> =>
  callFluCallable<{ id: string; superboardSync: TicketSuperboardSync }>("submitTicket", {
    kind,
    body,
    images: images.slice(0, TICKET_MAX_IMAGES),
    ...(logs ? { logs } : {}),
  });

// 관리자 페이지용 목록. 서버가 admin+ 만 허용한다.
export const listTickets = async (): Promise<{ tickets: Ticket[]; superboardConfigured: boolean }> =>
  callFluCallable<{ tickets: Ticket[]; superboardConfigured: boolean }>("listTickets");

export const setTicketStatus = async (ticketId: string, status: TicketStatus): Promise<void> => {
  await callFluCallable("setTicketStatus", { ticketId, status });
};

// 삭제 — 서버가 완료(done) 상태만 허용한다.
export const deleteTicket = async (ticketId: string): Promise<void> => {
  await callFluCallable("deleteTicket", { ticketId });
};

export const retryTicketSuperboardSync = async (ticketId: string): Promise<TicketSuperboardSync> =>
  (await callFluCallable<{ superboardSync: TicketSuperboardSync }>("retryTicketSuperboardSync", { ticketId }))
    .superboardSync;
