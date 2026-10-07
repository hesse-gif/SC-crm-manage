"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { createSeedData, deleteSeedData } from "@/lib/data";
import { isDevelopmentOnlyNoDataRoute, requestDataRefresh } from "@/lib/live";
import { useRole, canSeeAdmin } from "@/lib/role";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Plus, Close, Sparkles } from "@/components/icons";
import { cn } from "@/lib/cn";

// 플로팅 시드 위젯 — 로컬 에뮬레이터에서 Admin 이상에게만 노출되는 시드 추가·삭제 도구.
// 게이트는 사이드바와 동일한 패턴(useRole + canSeeAdmin: Admin rank 이상)을 따른다.
// 쓰기/삭제는 @/lib/data의 callable(createSeedData/deleteSeedData)만 경유한다(SEC-P0-004).

type Tone = "neutral" | "ai" | "ok" | "danger";
type Status = { tone: Tone; text: string } | null;
const seedCreationEnabled = process.env.NEXT_PUBLIC_USE_EMULATOR === "1";

// httpsCallable 에러에서 사람이 읽을 메시지를 뽑는다(verify 콘솔과 동일한 형태).
function errorText(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as { code?: unknown; message?: unknown };
    const code = typeof record.code === "string" ? record.code : "";
    const message = typeof record.message === "string" ? record.message : String(error);
    return [code, message].filter(Boolean).join(": ");
  }
  return String(error);
}

export function SeedWidget() {
  const { role } = useRole();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<null | "create" | "delete">(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  if (isDevelopmentOnlyNoDataRoute(pathname)) return null;
  if (!seedCreationEnabled) return null;

  // Admin 이상만 노출 (guest/viewer/manager는 렌더하지 않음).
  if (!canSeeAdmin(role) || pathname.startsWith("/chat")) return null;

  async function handleCreate() {
    if (!seedCreationEnabled) return;
    setPending("create");
    setStatus(null);
    try {
      const res = (await createSeedData()) as { written?: number };
      requestDataRefresh(); // 모든 라이브 페이지 재조회 → 화면 즉시 반영
      setStatus({ tone: "ok", text: `예시 데이터 ${res.written ?? ""}건을 로컬 에뮬레이터에 추가했어요.` });
    } catch (error) {
      setStatus({ tone: "danger", text: errorText(error) });
    } finally {
      setPending(null);
    }
  }

  async function handleDelete() {
    if (!seedCreationEnabled) return;
    setPending("delete");
    setStatus(null);
    try {
      const res = (await deleteSeedData()) as { deleted?: number };
      requestDataRefresh(); // 백그라운드 확정(서버 상태와 동기화)
      setStatus({ tone: "ok", text: `예시 데이터 ${res.deleted ?? ""}건을 삭제했어요.` });
    } catch (error) {
      requestDataRefresh(); // 실패 시 서버 상태로 롤백
      setStatus({ tone: "danger", text: errorText(error) });
    } finally {
      setPending(null);
      setConfirmDelete(false);
    }
  }

  const busy = pending !== null;

  return (
    <div className="fixed bottom-5 right-5 z-50">
      {open ? (
        <Card className="w-64 shadow-pop">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <div className="flex items-center gap-1.5 text-ink">
              <Sparkles width={16} height={16} className="text-accent" />
              <span className="text-[13px] font-bold">예시 데이터</span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-ink-3 transition-colors hover:text-ink"
              aria-label="닫기"
            >
              <Close width={16} height={16} />
            </button>
          </div>

          <div className="flex flex-col gap-2 px-4 py-3.5">
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={busy}
              className="w-full"
            >
              <Plus width={15} height={15} />
              {pending === "create" ? "추가 중…" : "예시 데이터 추가"}
            </Button>

            {confirmDelete ? (
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="danger"
                  onClick={handleDelete}
                  disabled={busy}
                  className="flex-1"
                >
                  {pending === "delete" ? "삭제 중…" : "삭제 확인"}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setConfirmDelete(false)}
                  disabled={busy}
                  className="flex-1"
                >
                  취소
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setStatus(null);
                  setConfirmDelete(true);
                }}
                disabled={busy}
                className="w-full"
              >
                예시 데이터 삭제
              </Button>
            )}

            {status && (
              <Badge tone={status.tone} className="mt-0.5 max-w-full">
                <span className="truncate">{status.text}</span>
              </Badge>
            )}
          </div>
        </Card>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="예시 데이터 위젯 열기"
          className={cn(
            "flex h-12 w-12 items-center justify-center rounded-full bg-accent text-white shadow-pop",
            "transition-colors hover:bg-accent/90",
          )}
        >
          <Sparkles width={20} height={20} />
        </button>
      )}
    </div>
  );
}
