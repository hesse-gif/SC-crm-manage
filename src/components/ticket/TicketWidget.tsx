"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { toCanvas } from "html-to-image";
import {
  submitTicket,
  listTickets,
  setTicketStatus,
  deleteTicket,
  retryTicketSuperboardSync,
  collectTicketLogs,
  TICKET_MAX_BODY,
  TICKET_MAX_IMAGES,
  TICKET_MAX_IMAGE,
  type Ticket,
  type TicketKind,
  type TicketStatus,
  type TicketSuperboardSync,
} from "@/lib/tickets";

// ─────────────────────────────────────────────────────────────────────────────
// 버그 제보 / 개선 의견 티켓 위젯
// 출처: supercent-io/ticket-widget-skill assets/TicketWidget.tsx (UI 구조·간격·의미 색 유지).
// Flu 적용 차이:
//   - 저장/열람은 전부 callable(@/lib/tickets) — 클라 Firestore 없음(SEC-P0-004).
//   - 삭제 확인은 window.confirm 대신 2단계 버튼(SeedWidget 과 동일 패턴 — e2e/브라우저 자동화가 모달에 막히지 않게).
//   - Admin 목록에 SuperBoard 전달 상태·재시도가 붙는다.
// 포인트 색은 CSS 변수 --ticket-accent / --ticket-accent-hover / --ticket-accent-active (globals.css).
// ─────────────────────────────────────────────────────────────────────────────

const formatTicketTime = (ms: number | null): string => {
  if (!ms) return "기록 없음";
  try {
    return new Date(ms).toLocaleString("ko-KR", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return "기록 없음";
  }
};

// 이미지 Blob → 축소된 JPEG data URL. 해상도·품질을 낮춰가며 장당 상한(TICKET_MAX_IMAGE)에 맞춘다.
// 화면 캡처는 대개 PNG라 원본이 크다 — JPEG로 바꾸는 것만으로 대부분 들어온다.
const shrinkTicketImage = async (file: Blob): Promise<string | null> => {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  for (const dim of [1600, 1200, 900]) {
    const scale = Math.min(1, dim / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const q of [0.8, 0.6, 0.45]) {
      const url = canvas.toDataURL("image/jpeg", q);
      if (url.length <= TICKET_MAX_IMAGE) {
        bitmap.close();
        return url;
      }
    }
  }
  bitmap.close();
  return null;
};

const TICKET_KIND_META: Record<TicketKind, { label: string; hint: string }> = {
  bug: { label: "버그 제보", hint: "동작이 잘못됐을 때" },
  idea: { label: "개선 의견", hint: "기능 추가 및 개선 아이디어" },
};

// 버튼 위치 — 우하단 기본, 드래그로 옮기면 뷰포트 기준 (right, bottom) 오프셋을 브라우저에 기억한다.
// Chat 의 메일 보내기 버튼처럼 우하단에 이미 액션이 있는 화면에서 사용자가 겹치지 않게 치울 수 있어야 한다.
const TICKET_BUTTON_POS_KEY = "flu.ticketButton.pos.v1";
const TICKET_BUTTON_SIZE = 48; // 버튼 className 의 h-12 w-12(48px)와 같이 바꿔야 클램프 경계가 맞는다
const TICKET_BUTTON_MARGIN = 8;
const DRAG_THRESHOLD_PX = 6;
type ButtonOffset = { right: number; bottom: number };

const clampOffset = (offset: ButtonOffset): ButtonOffset => ({
  right: Math.min(Math.max(offset.right, TICKET_BUTTON_MARGIN), Math.max(TICKET_BUTTON_MARGIN, window.innerWidth - TICKET_BUTTON_SIZE - TICKET_BUTTON_MARGIN)),
  bottom: Math.min(Math.max(offset.bottom, TICKET_BUTTON_MARGIN), Math.max(TICKET_BUTTON_MARGIN, window.innerHeight - TICKET_BUTTON_SIZE - TICKET_BUTTON_MARGIN)),
});

const readSavedOffset = (): ButtonOffset | null => {
  try {
    const raw = window.localStorage.getItem(TICKET_BUTTON_POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ButtonOffset>;
    if (typeof parsed.right !== "number" || typeof parsed.bottom !== "number") return null;
    return clampOffset(parsed as ButtonOffset);
  } catch {
    return null;
  }
};

export const TicketButton = ({ userEmail, defaultOffset = { right: 20, bottom: 20 } }: { userEmail: string; defaultOffset?: ButtonOffset }) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [offset, setOffset] = useState<ButtonOffset>(defaultOffset);
  const [dragging, setDragging] = useState(false);
  // 드래그 판정: pointerdown 지점에서 6px 이상 움직이면 드래그(클릭 아님). 클릭은 모달을 연다.
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; origin: ButtonOffset; moved: boolean } | null>(null);

  useEffect(() => {
    const saved = readSavedOffset();
    if (saved) setOffset(saved);
    const onResize = () => setOffset((prev) => clampOffset(prev));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origin: offset, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    d.moved = true;
    setDragging(true);
    setOffset(clampOffset({ right: d.origin.right - dx, bottom: d.origin.bottom - dy }));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (d.moved) {
      setDragging(false);
      try {
        window.localStorage.setItem(TICKET_BUTTON_POS_KEY, JSON.stringify(clampOffset({ right: d.origin.right - (e.clientX - d.startX), bottom: d.origin.bottom - (e.clientY - d.startY) })));
      } catch {
        /* 저장 실패는 무해 — 다음 방문에 기본 위치 */
      }
      return;
    }
    open();
  };
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<TicketKind>("bug");
  const [body, setBody] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  // 화면 캡처 — 정지 프레임과 드래그 선택 영역(뷰포트 좌표)
  const [shot, setShot] = useState<{ url: string; w: number; h: number } | null>(null);
  const [drag, setDrag] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  const open = () => {
    setKind("bug");
    setBody("");
    setImages([]);
    setError("");
    setDone(false);
    dialogRef.current?.showModal();
  };

  const pick = async (files: FileList | null | undefined) => {
    const picked = Array.from(files ?? []).filter((f) => f.type.startsWith("image/"));
    if (!picked.length) return;
    setError("");
    const room = TICKET_MAX_IMAGES - images.length;
    if (room <= 0) {
      setError(`이미지는 ${TICKET_MAX_IMAGES}장까지 첨부할 수 있습니다.`);
      return;
    }
    const urls = await Promise.all(picked.slice(0, room).map((f) => shrinkTicketImage(f).catch(() => null)));
    const ok = urls.filter((u): u is string => u !== null);
    if (ok.length < picked.length) {
      setError(
        picked.length > room
          ? `이미지는 ${TICKET_MAX_IMAGES}장까지 첨부할 수 있습니다.`
          : "일부 이미지를 첨부하지 못했습니다. 다른 이미지로 시도해 주세요.",
      );
    }
    setImages((prev) => [...prev, ...ok].slice(0, TICKET_MAX_IMAGES));
  };

  // 화면 캡처: 모달을 잠깐 닫고 → 현재 DOM을 캔버스로 렌더해 정지 화면으로 뜬 뒤 →
  // 드래그한 영역만 잘라 첨부한다. getDisplayMedia가 아니라 DOM 렌더링(html-to-image)이라
  // 브라우저의 "이 탭을 보도록 허용" 공유 프롬프트가 뜨지 않는다.
  // 한계: 교차 출처 이미지·iframe·WebGL 내용은 빠질 수 있다(사내 툴 DOM 기준 충분).
  const captureScreen = async () => {
    dialogRef.current?.close();
    try {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const page = await toCanvas(document.body, { pixelRatio: dpr });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      canvas.getContext("2d")?.drawImage(
        page,
        window.scrollX * dpr, window.scrollY * dpr, canvas.width, canvas.height,
        0, 0, canvas.width, canvas.height,
      );
      setShot({ url: canvas.toDataURL("image/png"), w: canvas.width, h: canvas.height });
    } catch {
      setError("화면을 캡처하지 못했습니다. 스크린샷을 직접 붙여넣어 주세요.");
      dialogRef.current?.showModal();
    }
  };

  const cancelShot = useCallback(() => {
    setShot(null);
    setDrag(null);
    dialogRef.current?.showModal();
  }, []);

  // 드래그 종료 → object-contain으로 그려진 프레임 좌표로 환산해 잘라 첨부
  const cropShot = async () => {
    if (!shot || !drag) return;
    const scale = Math.min(window.innerWidth / shot.w, window.innerHeight / shot.h);
    const ox = (window.innerWidth - shot.w * scale) / 2;
    const oy = (window.innerHeight - shot.h * scale) / 2;
    const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));
    const sx = clamp((Math.min(drag.x1, drag.x2) - ox) / scale, shot.w);
    const sy = clamp((Math.min(drag.y1, drag.y2) - oy) / scale, shot.h);
    const sw = clamp(Math.abs(drag.x2 - drag.x1) / scale, shot.w - sx);
    const sh = clamp(Math.abs(drag.y2 - drag.y1) / scale, shot.h - sy);
    if (sw < 8 || sh < 8) {
      setDrag(null); // 클릭만 한 경우 — 선택을 지우고 다시 드래그를 기다린다
      return;
    }
    const img = new Image();
    img.src = shot.url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    canvas.getContext("2d")?.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    cancelShot();
    if (!blob) return;
    const url = await shrinkTicketImage(blob).catch(() => null);
    if (!url) {
      setError("캡처 이미지를 첨부하지 못했습니다. 다시 시도해 주세요.");
      return;
    }
    setImages((prev) => [...prev, url].slice(0, TICKET_MAX_IMAGES));
  };

  // 캡처 중 ESC로 취소
  useEffect(() => {
    if (!shot) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancelShot();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shot, cancelShot]);

  const submit = async () => {
    if (!body.trim() || sending || !userEmail) return;
    setSending(true);
    setError("");
    try {
      // 버그 제보에는 최근 콘솔 로그(error/warn)+환경 정보, 개선 의견에는 페이지 정보·이동 자취만 담는다.
      await submitTicket(kind, body.trim(), images, collectTicketLogs(kind));
      setDone(true);
      setTimeout(() => dialogRef.current?.close(), 1600);
    } catch (err) {
      console.error("[tickets] submit failed:", err);
      setError("전송하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { dragRef.current = null; setDragging(false); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
        data-testid="ticket-widget-button"
        aria-label="버그 제보 · 개선 의견 (드래그해서 옮길 수 있음)"
        title="버그 제보 · 개선 의견 — 드래그해서 옮길 수 있어요"
        style={{ right: offset.right, bottom: offset.bottom, touchAction: "none" }}
        className={`fixed z-40 flex h-12 w-12 select-none items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-card transition-colors hover:border-[var(--ticket-accent)] hover:text-[var(--ticket-accent)] ${dragging ? "cursor-grabbing scale-105 shadow-pop" : "cursor-pointer"}`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="h-[22px] w-[22px]" aria-hidden="true">
          <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 9 9 0 0 1-3.4-.6L4 21l1.3-3.6A8.4 8.4 0 0 1 4 11.5 8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5zM9 10h7M9 13.5h4.5" />
        </svg>
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby="ticket-title"
        className="ticket-dialog m-auto w-[28rem] max-w-[calc(100%-2rem)] rounded-2xl border border-slate-200/70 bg-white p-0 text-slate-900 shadow-2xl"
      >
        {done ? (
          <div className="px-7 py-14 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-slate-100">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5" /></svg>
            </div>
            <p className="mt-4 text-[0.9375rem] font-semibold">보내주셔서 감사합니다</p>
            <p className="mt-1.5 text-sm text-slate-500">확인 후 반영하겠습니다.</p>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-4 px-7 pb-5 pt-6">
              <div>
                <h2 id="ticket-title" className="text-lg font-bold tracking-tight">의견 보내기</h2>
                <p className="mt-1 text-sm text-slate-500">불편한 점이나 아이디어를 알려주세요.</p>
              </div>
              <button
                type="button"
                onClick={() => dialogRef.current?.close()}
                aria-label="닫기"
                className="-mr-2 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 cursor-pointer"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" className="h-4 w-4" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>

            {/* 종류 — 리스트 행 2줄. 선택은 배경 한 단계 + 체크로만 표시한다(액센트 없음) */}
            <div className="border-y border-slate-200/70">
              {(Object.keys(TICKET_KIND_META) as TicketKind[]).map((k, i) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  aria-pressed={kind === k}
                  className={`flex w-full items-center gap-4 border-0 px-7 py-3.5 text-left transition-colors cursor-pointer ${
                    i > 0 ? "border-t border-slate-200/70" : ""
                  } ${
                    kind === k
                      ? "bg-slate-100 text-slate-900"
                      : "bg-transparent text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                  }`}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px] shrink-0" aria-hidden="true">
                    <path d={k === "bug" ? "M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3 3 0 1 1 6 0v1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6zM12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.8 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.2 3.8 1.9 3.8 4" : "M9 18h6M10 21h4M12 3a6 6 0 0 0-3 11v2h6v-2a6 6 0 0 0-3-11z"} />
                  </svg>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{TICKET_KIND_META[k].label}</span>
                    <span className="mt-0.5 block text-xs text-slate-400">{TICKET_KIND_META[k].hint}</span>
                  </span>
                  {kind === k && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5" /></svg>
                  )}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-4 px-7 pb-7 pt-4">
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                // 버그 제보의 대부분은 화면 캡처다 — 붙여넣기가 가장 짧은 경로다.
                onPaste={(e) => void pick(e.clipboardData.files)}
                rows={6}
                maxLength={TICKET_MAX_BODY}
                autoFocus
                aria-label={TICKET_KIND_META[kind].label}
                placeholder={kind === "bug" ? "어떤 문제가 있었나요?\n사진을 함께 첨부해주시면 빠르게 해결할 수 있어요." : "어떤 기능이 있으면 좋을까요?\n왜 필요한지 함께 적어주세요."}
                className="w-full resize-none rounded-xl bg-slate-50 px-4 py-3.5 text-sm leading-relaxed outline-none ring-[0.5px] ring-slate-200/70 transition-shadow placeholder:text-slate-400 focus:ring-[var(--ticket-accent)]"
              />

              {images.length > 0 && (
                <ul className="flex flex-wrap gap-2">
                  {images.map((url, i) => (
                    <li key={i} className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element -- data URL 미리보기 */}
                      <img src={url} alt={`첨부 이미지 ${i + 1}`} className="h-16 w-16 rounded-xl border border-slate-200/70 object-cover" />
                      <button
                        type="button"
                        onClick={() => setImages(images.filter((_, j) => j !== i))}
                        aria-label={`이미지 ${i + 1} 제거`}
                        title="이미지 제거"
                        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full border-0 bg-slate-900/70 text-white transition-colors hover:bg-slate-900/90 cursor-pointer"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" className="h-3 w-3" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {error && (
                <p role="alert" className="text-xs leading-relaxed text-red-600">{error}</p>
              )}

              {/* 로그가 함께 가는 건 사용자에게 알린다 — 몰래 수집하지 않는다 */}
              <p className="text-xs text-slate-400">
                {kind === "bug"
                  ? "빠른 확인을 위해 현재 페이지·최근 콘솔 로그(오류·경고)·브라우저 정보가 함께 전송됩니다."
                  : "현재 페이지 정보가 함께 전송됩니다."}
              </p>

              <div className="flex items-center gap-3 pt-3">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    void pick(e.target.files);
                    e.target.value = ""; // 같은 파일을 다시 골라도 change가 오게
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={images.length >= TICKET_MAX_IMAGES}
                  aria-label="이미지 첨부"
                  title="이미지 첨부"
                  className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-slate-200/70 bg-transparent px-3.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 cursor-pointer disabled:pointer-events-none disabled:opacity-40"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" className="h-4 w-4" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                  첨부
                  {images.length > 0 && <span className="tabular-nums text-slate-400">{images.length}</span>}
                </button>
                <button
                  type="button"
                  onClick={() => void captureScreen()}
                  disabled={images.length >= TICKET_MAX_IMAGES}
                  aria-label="화면 캡처"
                  title="화면 캡처 — 드래그한 영역이 첨부됩니다"
                  className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-slate-200/70 bg-transparent px-3.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 cursor-pointer disabled:pointer-events-none disabled:opacity-40"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M8 12a4 4 0 1 0 8 0 4 4 0 0 0-8 0z" /></svg>
                  캡처
                </button>
                {/* 글자 수는 한도에 가까워질 때만 — 평소엔 노이즈다 */}
                {body.length > TICKET_MAX_BODY * 0.8 && (
                  <span className="text-xs tabular-nums text-slate-400">{body.length}/{TICKET_MAX_BODY}자</span>
                )}
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={!body.trim() || sending}
                  // 포인트 색·글자색은 globals.css 의 .ticket-send 가 쥔다(유틸리티 순서에 밀리지 않게)
                  className="ticket-send ml-auto h-9 shrink-0 rounded-xl border-0 px-5 text-sm font-semibold transition-colors cursor-pointer disabled:pointer-events-none disabled:bg-slate-200 disabled:text-slate-400"
                >
                  {sending ? "보내는 중…" : "보내기"}
                </button>
              </div>
            </div>
          </>
        )}
      </dialog>

      {/* 캡처 오버레이 — 모달이 닫힌 사이 정지 프레임 위에서 영역을 드래그한다.
          선택 밖 딤은 selection div의 거대 box-shadow 한 장으로 처리. 마우스 전용(사내 데스크톱 툴 기준). */}
      {shot && (
        <div
          role="dialog"
          aria-label="화면 캡처 — 드래그해서 영역을 선택하세요. ESC로 취소"
          className="fixed inset-0 z-[999] cursor-crosshair select-none bg-black"
          onMouseDown={(e) => setDrag({ x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY })}
          onMouseMove={(e) => drag && setDrag({ ...drag, x2: e.clientX, y2: e.clientY })}
          onMouseUp={() => void cropShot()}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- 캡처 정지 프레임 */}
          <img src={shot.url} alt="" draggable={false} className="h-full w-full object-contain" />
          {drag ? (
            <div
              className="absolute border border-white/90 shadow-[0_0_0_100vmax_rgba(0,0,0,0.5)]"
              style={{
                left: Math.min(drag.x1, drag.x2),
                top: Math.min(drag.y1, drag.y2),
                width: Math.abs(drag.x2 - drag.x1),
                height: Math.abs(drag.y2 - drag.y1),
              }}
            />
          ) : (
            <p className="pointer-events-none absolute left-1/2 top-6 -translate-x-1/2 rounded-full bg-black/70 px-4 py-2 text-sm text-white">
              드래그해서 첨부할 영역을 선택하세요 · ESC 취소
            </p>
          )}
        </div>
      )}
    </>
  );
};

const SYNC_META: Record<TicketSuperboardSync["status"], { label: string; className: string }> = {
  synced: { label: "SuperBoard 전달됨", className: "bg-emerald-100 text-emerald-700" },
  failed: { label: "SuperBoard 실패", className: "bg-red-100 text-red-700" },
  pending: { label: "SuperBoard 대기", className: "bg-slate-100 text-slate-600" },
  manual: { label: "SuperBoard 수동", className: "bg-amber-100 text-amber-700" },
};

export const AdminTicketsPanel = () => {
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [superboardConfigured, setSuperboardConfigured] = useState<boolean | null>(null);
  const [filter, setFilter] = useState<TicketStatus>("open");
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState("");

  const reload = useCallback(async () => {
    try {
      const res = await listTickets();
      setTickets(res.tickets);
      setSuperboardConfigured(res.superboardConfigured);
      setError("");
    } catch (err) {
      console.error("[tickets] list failed:", err);
      setTickets((prev) => prev ?? []);
      setError(`티켓을 불러오지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (id: string, action: () => Promise<void>, failText: string) => {
    setBusyId(id);
    setError("");
    try {
      await action();
      await reload();
    } catch (err) {
      console.error("[tickets] action failed:", err);
      setError(failText);
    } finally {
      setBusyId("");
    }
  };

  const toggleStatus = (t: Ticket) =>
    run(t.id, () => setTicketStatus(t.id, t.status === "open" ? "done" : "open"), "상태를 바꾸지 못했습니다. 잠시 후 다시 시도해 주세요.");

  // 완료된 티켓만 지운다 — 처리 전 제보가 실수로 사라지면 복구할 곳이 없다(서버도 동일하게 강제).
  const remove = (id: string) => {
    setConfirmDeleteId("");
    return run(id, () => deleteTicket(id), "삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  };

  const retrySync = (id: string) =>
    run(id, async () => { await retryTicketSuperboardSync(id); }, "SuperBoard 재전달에 실패했습니다. 잠시 후 다시 시도해 주세요.");

  const counts = {
    open: (tickets ?? []).filter((t) => t.status === "open").length,
    done: (tickets ?? []).filter((t) => t.status === "done").length,
  };
  const shown = (tickets ?? []).filter((t) => t.status === filter);

  return (
    <div data-testid="admin-tickets-panel">
      {error && (
        <div role="alert" className="mb-6 rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          {error}
        </div>
      )}
      {superboardConfigured === false && (
        <div className="mb-6 rounded-xl border border-line bg-fill px-4 py-3 text-xs text-ink-2">
          SuperBoard 자동 전달이 꺼져 있습니다(서버에 SUPERBOARD_TOKEN 없음). 티켓은 여기에 저장되며, 필요하면 <code className="font-mono">sb create</code> 로 수동 전달합니다.
        </div>
      )}

      <div className="flex items-center gap-1.5">
        {(["open", "done"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(s)}
            aria-pressed={filter === s}
            className={`rounded-lg border-0 px-3 py-1.5 text-sm font-semibold transition-colors cursor-pointer ${
              filter === s
                ? "bg-slate-900 text-white"
                : "bg-transparent text-slate-500 hover:bg-slate-100"
            }`}
          >
            {s === "open" ? "신규" : "완료"}
            <span className="ml-1.5 tabular-nums opacity-60">{counts[s]}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => void reload()}
          className="ml-auto rounded-lg border-0 bg-transparent px-3 py-1.5 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 cursor-pointer"
        >
          새로고침
        </button>
      </div>

      {tickets === null ? (
        <div className="flex items-center justify-center py-20">
          <span className="inline-block h-7 w-7 animate-spin rounded-full border-2 border-slate-500/40 border-b-transparent" aria-label="불러오는 중" />
        </div>
      ) : shown.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-slate-300 py-16 text-center text-slate-400">
          {filter === "open" ? "새 티켓이 없습니다." : "완료된 티켓이 없습니다."}
        </div>
      ) : (
        <ul className="mt-6 rounded-2xl border border-slate-200/70 bg-white px-5">
          {shown.map((t) => {
            const sync = SYNC_META[t.superboardSync.status];
            const busy = busyId === t.id;
            return (
              <li key={t.id} id={`ticket-${t.id}`} className="relative border-b border-slate-100 py-4 last:border-0">
                <div className="flex flex-wrap items-baseline gap-2 text-xs text-slate-500">
                  <span
                    className={`rounded px-1.5 py-0.5 font-semibold ${
                      t.kind === "bug" ? "bg-red-100 text-red-700" : "bg-blue-100 text-blue-700"
                    }`}
                  >
                    {t.kind === "bug" ? "버그" : "개선"}
                  </span>
                  <span className={`rounded px-1.5 py-0.5 font-semibold ${sync.className}`} title={t.superboardSync.error ?? undefined}>
                    {sync.label}
                    {t.superboardSync.ticketKey ? ` · ${t.superboardSync.ticketKey}` : ""}
                  </span>
                  <span className="truncate">{t.authorEmail}</span>
                  <span className="ml-auto shrink-0 tabular-nums">{formatTicketTime(t.createdAtMs)}</span>
                </div>
                {/* 제보는 원문 줄바꿈이 곧 정보다 — whitespace를 유지한다 */}
                <p className="mt-2 whitespace-pre-wrap pr-28 text-sm leading-relaxed text-slate-800">{t.body}</p>
                {t.images.length > 0 && (
                  // 목록에서는 줄여 보여주고, 원본은 새 탭에서 본다.
                  <div className="mt-3 flex flex-wrap gap-2 pr-28">
                    {t.images.map((url, i) => (
                      <a key={i} href={url} target="_blank" rel="noreferrer" className="block w-fit">
                        {/* eslint-disable-next-line @next/next/no-img-element -- data URL 첨부 */}
                        <img src={url} alt={`첨부 이미지 ${i + 1}`} className="max-h-40 rounded-lg border border-slate-200/70 object-contain" />
                      </a>
                    ))}
                  </div>
                )}
                {t.logs && (
                  // 로그는 접어 둔다 — 대개 길고, 본문·이미지가 먼저다.
                  <details className="mt-3 pr-28">
                    <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-700">
                      콘솔 로그 {t.logs.split("\n").length}줄
                    </summary>
                    <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-slate-600">{t.logs}</pre>
                  </details>
                )}
                {t.superboardSync.status === "failed" && t.superboardSync.error && (
                  <p className="mt-2 pr-28 text-xs text-red-600">전달 오류: {t.superboardSync.error}</p>
                )}
                {/* 액션은 카드 우하단에 겹쳐 둔다 — 행 높이를 늘리지 않는다(본문/이미지의 pr-28로 겹침 방지) */}
                <div className="absolute bottom-4 right-0 flex gap-2">
                  {superboardConfigured && t.superboardSync.status !== "synced" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void retrySync(t.id)}
                      className="rounded-md border-0 bg-slate-500/10 px-2.5 py-1 text-xs font-semibold text-slate-700 ring-1 ring-inset ring-slate-500/30 transition-all hover:bg-slate-500/20 cursor-pointer active:translate-y-px disabled:opacity-40"
                    >
                      SuperBoard 전달
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void toggleStatus(t)}
                    className={`rounded-md border-0 px-2.5 py-1 text-xs font-semibold ring-1 ring-inset transition-all cursor-pointer active:translate-y-px disabled:opacity-40 ${
                      t.status === "open"
                        ? "bg-emerald-500/15 text-emerald-700 ring-emerald-600/30 hover:bg-emerald-500/25 hover:ring-emerald-600/50"
                        : "bg-amber-500/15 text-amber-700 ring-amber-600/30 hover:bg-amber-500/25 hover:ring-amber-600/50"
                    }`}
                  >
                    {t.status === "open" ? "완료" : "신규로"}
                  </button>
                  {t.status === "done" && (
                    confirmDeleteId === t.id ? (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void remove(t.id)}
                          className="rounded-md border-0 bg-red-600 px-2.5 py-1 text-xs font-semibold text-white transition-all hover:bg-red-700 cursor-pointer active:translate-y-px disabled:opacity-40"
                        >
                          정말 삭제
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId("")}
                          className="rounded-md border-0 bg-transparent px-2.5 py-1 text-xs font-semibold text-slate-500 ring-1 ring-inset ring-slate-300 transition-all hover:bg-slate-100 cursor-pointer"
                        >
                          취소
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmDeleteId(t.id)}
                        className="rounded-md border-0 bg-red-500/15 px-2.5 py-1 text-xs font-semibold text-red-700 ring-1 ring-inset ring-red-600/30 transition-all hover:bg-red-500/25 hover:ring-red-600/50 cursor-pointer active:translate-y-px disabled:opacity-40"
                      >
                        삭제
                      </button>
                    )
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
