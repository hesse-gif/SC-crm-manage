"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Archive, Dots, Trash, UserCheck } from "@/components/icons";
import { updateWorkflowItemState, type WorkflowAction, type WorkflowEntity, type WorkflowItemStateEnvelope } from "@/lib/data";
import { requestDataRefresh } from "@/lib/live";
import { cn } from "@/lib/cn";

type WorkflowActionMenuProps = {
  entity: WorkflowEntity;
  id: string;
  label: string;
  protectedItem?: boolean;
  compact?: boolean;
  align?: "left" | "right";
  onCompleted?: (result: WorkflowItemStateEnvelope, action: WorkflowAction) => void;
  className?: string;
  // 0.6.73 Aside 핫픽스 — 이 컴포넌트는 공유 컴포넌트라 super_admin "대신 보기"(src/lib/viewAs.tsx)
  // 를 몰랐다: chat/page.tsx가 이 메뉴로 updateWorkflowItemState(사람 개입/보관/삭제)를 실제로
  // 호출할 수 있었다(읽기 전용 프리뷰 계약 위반, handleDraftSend/handleAiDraft 등과 같은 급의 결함).
  // 호출 측이 isViewingAs를 넘기면 메뉴 항목을 비활성화하고 runAction 자체도 방어한다.
  disabled?: boolean;
};

type ActionItem = {
  action: WorkflowAction;
  label: string;
  desc: string;
  icon: typeof UserCheck;
  danger?: boolean;
  disabledWhenProtected?: boolean;
};

const ACTIONS: ActionItem[] = [
  {
    action: "request_human",
    label: "사람 개입",
    desc: "AI를 멈추고 검수로 넘김",
    icon: UserCheck,
  },
  {
    action: "archive",
    label: "보관",
    desc: "목록에서 숨기고 기록 유지",
    icon: Archive,
    disabledWhenProtected: true,
  },
  {
    action: "delete",
    label: "삭제",
    desc: "soft delete로 숨김",
    icon: Trash,
    danger: true,
    disabledWhenProtected: true,
  },
];

export function WorkflowActionMenu({
  entity,
  id,
  label,
  protectedItem = false,
  compact = false,
  align = "right",
  onCompleted,
  className,
  disabled: viewingAsDisabled = false,
}: WorkflowActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<WorkflowAction | null>(null);
  const [status, setStatus] = useState("");
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updateMenuPosition = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const width = 208;
    const left = align === "right"
      ? Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))
      : Math.max(8, Math.min(window.innerWidth - width - 8, rect.left));
    setMenuStyle({
      position: "fixed",
      left,
      top: Math.min(window.innerHeight - 8, rect.bottom + 4),
      width,
    });
  }, [align]);

  useEffect(() => {
    if (!open) return undefined;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    }
    updateMenuPosition();
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, updateMenuPosition]);

  async function runAction(action: WorkflowAction) {
    if (busyAction || viewingAsDisabled) return;
    if (protectedItem && (action === "archive" || action === "delete")) {
      setStatus("보호된 테스트 항목");
      return;
    }
    if (action === "delete" && !window.confirm(`${label} 항목을 목록에서 숨길까요? 데이터는 soft delete로 보관됩니다.`)) {
      return;
    }

    setBusyAction(action);
    setStatus("");
    try {
      const result = await updateWorkflowItemState({
        entity,
        id,
        action,
        reason: `manual_${action}`,
        gameId: "flu-workflow",
      });
      if (result.blocked) {
        setStatus(result.message ?? "보호된 항목입니다.");
        return;
      }
      setStatus(action === "request_human" ? "검수로 넘김" : action === "archive" ? "보관됨" : "삭제됨");
      setOpen(false);
      onCompleted?.(result, action);
      requestDataRefresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "처리에 실패했습니다.");
    } finally {
      setBusyAction(null);
    }
  }

  const menu = open ? (
    <div
      ref={menuRef}
      className="z-50 rounded-lg border border-line bg-paper p-1.5 shadow-pop"
      style={menuStyle}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="border-b border-line px-2 py-1.5">
        <div className="truncate text-[11px] font-semibold text-ink">{label}</div>
        <div className="mt-0.5 text-[10px] text-ink-4">수동 워크플로우</div>
      </div>
      <div className="py-1">
        {ACTIONS.map((item) => {
          const Icon = item.icon;
          const disabled = busyAction !== null || viewingAsDisabled || (protectedItem && item.disabledWhenProtected);
          return (
            <button
              key={item.action}
              type="button"
              disabled={disabled}
              onClick={() => void runAction(item.action)}
              title={viewingAsDisabled ? "대신 보기 중에는 비활성" : undefined}
              className={cn(
                "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-fill disabled:cursor-not-allowed disabled:opacity-45",
                item.danger ? "text-danger" : "text-ink-2",
              )}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0">
                <span className="block text-xs font-semibold">
                  {busyAction === item.action ? "처리 중" : item.label}
                </span>
                <span className="mt-0.5 block text-[10px] leading-snug text-ink-4">{item.desc}</span>
              </span>
            </button>
          );
        })}
      </div>
      {status && <div className="border-t border-line px-2 py-1.5 text-[10px] font-medium text-ink-3">{status}</div>}
    </div>
  ) : null;

  return (
    <div
      ref={rootRef}
      className={cn("relative inline-flex", className)}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "grid place-items-center rounded-md border border-transparent text-ink-3 transition-colors hover:border-line hover:bg-fill hover:text-ink",
          compact ? "h-7 w-7" : "h-8 w-8",
        )}
        aria-label={`${label} 수동 조작`}
        title={`${label} 수동 조작`}
      >
        <Dots className={compact ? "h-4 w-4" : "h-[18px] w-[18px]"} />
      </button>

      {menu ? createPortal(menu, document.body) : null}
    </div>
  );
}
