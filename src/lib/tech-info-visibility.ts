"use client";

// P11 — 파트너 화면의 "기술 정보"(원천/식별자/프로필ID/submissions·Sheet3·creator_link·submission_task 뱃지)
// 노출 토글. 기본은 접힘(false)이고, manager 이상만 펼칠 수 있다(Q8 확정값). 클라이언트 숨김이므로
// 서버 payload 자체의 노출 여부는 별도 확인 대상(A12) — 이 훅은 UI 노출만 통제한다.
import { useState } from "react";
import { ROLES } from "@/lib/data";
import { useRole } from "@/lib/role";

export function useTechInfoVisibility() {
  const { role } = useRole();
  const [open, setOpen] = useState(false);
  const allowed = (ROLES[role]?.rank ?? 0) >= ROLES.manager.rank;
  return {
    allowed,
    visible: allowed && open,
    toggle: () => setOpen((value) => !value),
  };
}
