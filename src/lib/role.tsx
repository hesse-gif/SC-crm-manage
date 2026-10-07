"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "firebase/auth";
import { subscribeAuthState } from "@/lib/auth";
import { type Role, ROLES } from "@/lib/data";

type AuthProfile = {
  team: string | null;
  name: string;
  email: string;
  photoURL: string;
  claimSyncReason: string | null;
};

// 실제 운영 권한의 클라이언트 표현. 서버 검증이 최종 권한이며,
// 클라이언트 preview는 실제 클레임 이하 다운그레이드 테스트에만 사용한다.
type RoleState = AuthProfile & { role: Role; setRole: (r: Role) => void };
const EMPTY_PROFILE: AuthProfile = { team: null, name: "", email: "", photoURL: "", claimSyncReason: null };
const RoleCtx = createContext<RoleState>({ role: "guest", setRole: () => {}, ...EMPTY_PROFILE });

// 사이드바 프로필 등 표시 전용으로 Firebase Auth user(Google 프로필) 노출.
const AuthUserCtx = createContext<User | null>(null);
const AuthProfileCtx = createContext<AuthProfile>(EMPTY_PROFILE);

// F2/A10 (2026-09-06 Aside 게이트 후속): 역할 미리보기(데모)가 서버 클레임과 같은 useState
// 하나를 공유했다 — subscribeAuthState 의 콜백(onIdTokenChanged, 다른 페이지의 강제 토큰 갱신이
// 전역으로 전파되면 더 자주 발생)이 다시 불릴 때마다 setRole(실제 클레임)로 미리보기를
// 덮어썼다. 실측: 리로드는 물론, 같은 워크스페이스 안 네비게이션에서도 재현(Manager 미리보기 →
// /flu/settings 이동 → Super Admin으로 원복). 그 결과 운영자가 낮은 권한 화면을 믿고 미리 볼 수
// 없었다. 고침: 실제 클레임(realRole)과 미리보기 요청(previewRole)을 별도 state로 분리하고,
// 화면에 보이는 role 은 매 렌더마다 "미리보기가 있으면 실제 클레임 이하로 clamp, 없으면 실제
// 클레임"으로 계산한다 — realRole 이 배경에서 갱신돼도 previewRole 은 그 갱신에 영향받지 않는다.
const PREVIEW_ROLE_STORAGE_KEY = "flu.role.preview";

function readStoredPreviewRole(): Role | null {
  try {
    const stored = window.sessionStorage.getItem(PREVIEW_ROLE_STORAGE_KEY);
    return stored && Object.prototype.hasOwnProperty.call(ROLES, stored) ? (stored as Role) : null;
  } catch {
    // 프라이빗 모드 등 storage 접근 불가 환경 — 미리보기가 세션 안에서 못 버틸 뿐 화면은 그대로 동작한다.
    return null;
  }
}

function writeStoredPreviewRole(role: Role | null) {
  try {
    if (role) window.sessionStorage.setItem(PREVIEW_ROLE_STORAGE_KEY, role);
    else window.sessionStorage.removeItem(PREVIEW_ROLE_STORAGE_KEY);
  } catch {
    // 위와 같은 이유로 조용히 무시한다 — 미리보기는 어차피 화면 표시 전용(cosmetic-only)이다.
  }
}

export function RoleProvider({ children }: { children: ReactNode }) {
  const [realRole, setRealRole] = useState<Role>("guest");
  // null = 미리보기 없음(실제 클레임을 그대로 보여준다).
  const [previewRole, setPreviewRole] = useState<Role | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AuthProfile>(EMPTY_PROFILE);

  // 탭이 살아 있는 동안(reload 포함)만 유지하면 되는 데모용 값이라 sessionStorage 를 쓴다.
  useEffect(() => {
    setPreviewRole(readStoredPreviewRole());
  }, []);

  useEffect(() => subscribeAuthState((state) => {
    setRealRole(state.role ?? "guest");
    setUser(state.user);
    setProfile({
      team: state.team ?? null,
      name: state.name ?? state.user?.displayName ?? state.user?.email ?? "",
      email: state.email ?? state.user?.email ?? "",
      photoURL: state.photoURL ?? state.user?.photoURL ?? "",
      claimSyncReason: state.claimSyncReason ?? null,
    });
    // 실제 로그아웃(로딩이 끝났는데 user 가 없다 — 최초 동기 콜백의 loading:true 는 제외)이면
    // 미리보기도 함께 지운다. 다음 로그인은 실제 클레임부터 새로 시작한다.
    if (!state.loading && !state.user) {
      setPreviewRole(null);
      writeStoredPreviewRole(null);
    }
  }), []);

  const setRole = useCallback((requested: Role) => {
    setPreviewRole(requested);
    writeStoredPreviewRole(requested);
  }, []);

  // 매 렌더마다 다시 계산 — realRole 이 배경에서(예: 다른 페이지가 강제한 토큰 갱신) 바뀌어도
  // 항상 최신 실제 클레임 기준으로 다운그레이드만 허용한다(자가 승격 방지, clampPreviewRole 과 동일 규칙).
  const role = previewRole !== null ? clampPreviewRole(previewRole, realRole) : realRole;

  return (
    <RoleCtx.Provider value={{ role, setRole, ...profile }}>
      <AuthUserCtx.Provider value={user}>
        <AuthProfileCtx.Provider value={profile}>{children}</AuthProfileCtx.Provider>
      </AuthUserCtx.Provider>
    </RoleCtx.Provider>
  );
}

export const useRole = () => useContext(RoleCtx);

// 로그인한 사용자의 Google 프로필(photoURL/displayName/email). 표시 전용.
export const useAuthUser = () => useContext(AuthUserCtx);
export const useAuthProfile = () => useContext(AuthProfileCtx);

// admin 워크스페이스 접근 가능 여부 (Admin 이상)
export const canSeeAdmin = (role: Role) => ROLES[role].rank >= ROLES.admin.rank;

// 역할 미리보기 스위처 허용 여부.
// 에뮬레이터/개발 환경에서만 표시 (프로덕션에서는 절대 렌더링 금지).
export const canPreviewRoles = (isEmulator: boolean) => isEmulator;

// 미리보기 요청 역할을 실제 서버 클레임 이하로 클램프.
// 상위 역할로의 자가 승격을 방지 (다운그레이드 테스트만 허용).
export const clampPreviewRole = (requested: Role, actualClaim: Role): Role =>
  ROLES[requested].rank <= ROLES[actualClaim].rank ? requested : actualClaim;
