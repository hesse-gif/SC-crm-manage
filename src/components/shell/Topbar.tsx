"use client";

import { useEffect, useMemo, useState, type FormEvent, type RefObject } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, Bell, Menu, Shield } from "@/components/icons";
import { useLive, useLiveConversations, useLiveMembers } from "@/lib/live";
import { LoadingStatus } from "@/components/ui/LoadingStatus";
import { isVisibleConversation, normalizeConversations } from "@/lib/chat-normalization";
import { logBehavior, ROLES, type BehaviorLogPayload, type Conversation, type Member } from "@/lib/data";
import { useAuthProfile, useRole } from "@/lib/role";
import { useViewAs } from "@/lib/viewAs";
import { useReviewInboxCount } from "@/components/flu/scpAutomation/ReviewInboxPanel";
import { useOrgContext } from "@/lib/useNavPreset";
import { externalFluHref } from "@/lib/flu-external-link";

function unreadCount(conversation: Conversation): number {
  return Number.isFinite(conversation.unread) && conversation.unread > 0 ? Math.floor(conversation.unread) : 0;
}

// admin/members/page.tsx와 동일한 판정 — Member.id는 초대만 되고 아직 로그인 전이면 Firebase Auth
// uid가 아닐 수 있다(functions/admin.ts setMemberRole의 "awaiting_oauth_login"). uid가 없는
// 멤버는 대신 볼 클레임/조직 컨텍스트 자체가 없으므로 대상 후보에서 제외한다.
function memberUid(member: Member): string | undefined {
  const uid = (member as { uid?: unknown }).uid;
  return typeof uid === "string" && uid.trim() ? uid.trim() : undefined;
}

function NotificationCountBadge({ count, urgent = false }: { count: number; urgent?: boolean }) {
  return (
    <span
      className={[
        "inline-flex h-6 min-w-8 shrink-0 items-center justify-center rounded-full px-2 text-[11px] font-bold tabular-nums",
        count > 0 && urgent ? "bg-danger-soft text-danger" : "",
        count > 0 && !urgent ? "bg-accent-soft text-accent" : "",
        count === 0 ? "bg-fill text-ink-4" : "",
      ].filter(Boolean).join(" ")}
    >
      {count}건
    </span>
  );
}

// 검색바: Enter 시 검색 결과 페이지로 이동(매칭 + 유사 채널). 계정 위젯은 사이드바 좌하단.
export function Topbar({
  mobileNavOpen,
  mobileNavButtonRef,
  onOpenNavigation,
}: {
  mobileNavOpen: boolean;
  mobileNavButtonRef: RefObject<HTMLButtonElement | null>;
  onOpenNavigation: () => void;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const { stale, loadingKeys, loadKeys } = useLive();
  const rawConversations = useLiveConversations<Conversation>([]);

  // Flu/Task-50 — 슈퍼어드민 쉐도우 로그인("대신 보기"). 진입점은 super_admin에게만 렌더링한다
  // (guest/admin/manager/viewer는 이 블록 자체가 안 그려진다) — 서버(getMyOrgContext)도 매 호출
  // 마다 동일하게 재검증하므로(AUTH-P0-003), 여기서 role을 속여도 permission-denied로 막힌다.
  const { role } = useRole();
  const { email: myEmail } = useAuthProfile();
  const canViewAs = role === "super_admin";
  const { target: viewAsTarget, startViewAs, stopViewAs } = useViewAs();
  const [viewAsMenuOpen, setViewAsMenuOpen] = useState(false);
  // src/lib/live.tsx의 datasetKeysForPath는 페이지별로 다른 키 집합을 싣는다(예: "members"는
  // /admin·/flu/campaigns·/flu/new·/flu/settings 에서만) — Topbar는 모든 페이지에 떠 있으므로
  // 현재 페이지가 무엇이든 대신 보기 대상 후보가 비어 있지 않도록 명시적으로 요청한다.
  // 2026-09-11 적대 리뷰 P1-2: 예전엔 super_admin이 어느 페이지를 열든 무조건 로드했다(매
  // 페이지뷰마다 불필요한 members 조회) — 이제 셀렉터를 실제로 열 때만 로드한다. loadKeys의 세
  // 번째 인자가 force다(background가 아니라) — 셀렉터를 다시 열 때마다 신선한 목록을 보장하려고
  // 명시적으로 true를 준다.
  useEffect(() => {
    if (!canViewAs || !viewAsMenuOpen) return;
    void loadKeys(["members"], true, true);
  }, [canViewAs, viewAsMenuOpen, loadKeys]);
  const members = useLiveMembers<Member>([]);
  const [viewAsQuery, setViewAsQuery] = useState("");
  // 0.6.73 Aside 핫픽스: 셀렉터를 열 때만 로드하는(위 loadKeys effect) 비동기 members 조회가 아직
  // 비어 있는 동안에도 아래 목록은 "일치하는 사용자가 없습니다"를 보여줘 실제로는 로딩 중일 뿐인
  // 상태를 "검색 결과 없음"으로 오인하게 했다 — 렌더 쪽에서 이 값으로 분기한다.
  const viewAsMembersLoading = Boolean(loadingKeys.members);
  const viewAsCandidates = useMemo(() => {
    if (!canViewAs) return [];
    const q = viewAsQuery.trim().toLowerCase();
    // 0.6.73 Aside 핫픽스: members 컬렉션에 같은 uid를 가리키는 중복 문서가 있으면(레거시 데이터)
    // 검색 결과에 동일인이 여러 줄로 찍혔다("sam" 중복 실측) — uid 기준으로 첫 매치만 남긴다.
    const seenUids = new Set<string>();
    const deduped: Member[] = [];
    for (const member of members) {
      const uid = memberUid(member);
      if (member.status !== "active" || member.email.toLowerCase() === myEmail.toLowerCase() || !uid) continue;
      if (seenUids.has(uid)) continue;
      seenUids.add(uid);
      deduped.push(member);
    }
    return deduped
      .filter((member) => !q || member.name.toLowerCase().includes(q) || member.email.toLowerCase().includes(q))
      .slice(0, 20);
  }, [canViewAs, members, myEmail, viewAsQuery]);

  function selectViewAsTarget(member: Member) {
    const uid = memberUid(member);
    if (!uid) return;
    startViewAs({ userId: uid, email: member.email, name: member.name });
    setViewAsMenuOpen(false);
    setViewAsQuery("");
  }

  // 종료는 로컬 상태 정리만으로 완결되는 동작(실제 세션/토큰을 건드리지 않는다)이라 서버 호출이
  // 필수는 아니지만, 요구사항(쉐도우 조회 "시작/종료" 각각 감사 로그)을 만족하려면 종료도 감사
  // 기록이 남아야 한다 — 새 콜러블을 추가하는 대신 기존 범용 감사 콜러블(logBehavior, admin+)을
  // 재사용한다(src/app/(app)/flu/data/page.tsx exportFilteredCsv와 동일 패턴: 필드 일부만 채우고
  // 나머지는 서버가 auth에서 채운다). 감사 기록 실패는 조용히 무시 — 프리뷰 해제 자체는 이미
  // 로컬에서 끝났고, 실패를 이유로 사용자를 다시 쉐도우 상태로 되돌릴 이유가 없다.
  async function endViewAs() {
    if (!viewAsTarget) return;
    const endedTarget = viewAsTarget;
    stopViewAs();
    try {
      await logBehavior({
        action: `viewAs.end(${endedTarget.userId})`,
        gameId: "global",
        result: "success",
        costKRW: 0,
        time: new Date().toISOString(),
      } as BehaviorLogPayload);
    } catch {
      // 위 주석 참조.
    }
  }
  const conversations = useMemo(
    () => normalizeConversations(rawConversations).filter(isVisibleConversation),
    [rawConversations],
  );
  // 2026-09-17 [헤세] — 구 검수 대기 알림 은퇴, 콘텐츠 검수 인박스(/flu/scp?tab=inbox)가 정본이다.
  // 영상·신청자 소스는 Topbar 가 모든 페이지에 항상 떠 있어 무조건 부르면 비용이 크므로, 알림
  // 드롭다운을 실제로 열었을 때만 불러온다(enabled=notificationsOpen) — 아래 bell 점(dot)은 그래서
  // 열기 전엔 문의(reviews, 이미 전역 구독) 몫만 반영하고, 연 뒤에는 인박스 전체로 갱신된다.
  // 2026-09-27 security fix (fix/scp-surface-gate, codex round-3 adversarial review): the
  // 인박스 link below resolves to REVIEW_INBOX_HREF (/flu/scp?tab=inbox), which is now
  // entitlement-gated (FluTabGate + /flu/scp/page.tsx) — role alone must not keep showing this
  // notification-menu entry (or fetching its count) for a caller without scpAccessGranted.
  const orgContext = useOrgContext();
  const canReadReviewInbox = ROLES[role].rank >= ROLES.manager.rank && orgContext?.scpAccessGranted === true;
  const reviewInboxCount = useReviewInboxCount(notificationsOpen && canReadReviewInbox);
  const unreadMessageCount = conversations.reduce((sum, conversation) => sum + unreadCount(conversation), 0);
  const totalNotificationCount = reviewInboxCount + unreadMessageCount;
  // R7 P10: 기존 stale 신호(계산만 되고 미소비였음) + 알림 키(reviews/conversations) 백그라운드 로딩을
  // 셸 소형 인디케이터로 노출 — 화면 전환마다 재계산되는 값이라 stale일 때만 잠깐 보인다.
  const syncing = stale || Boolean(loadingKeys.reviews) || (Boolean(loadingKeys.conversations) && rawConversations.length === 0);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (q.trim()) router.push(`/chat?search=${encodeURIComponent(q.trim())}`);
  };

  return (
    <div className="sticky top-0 z-30">
      {canViewAs && viewAsTarget ? (
        <div className="flex h-9 items-center justify-center gap-3 border-b border-accent/30 bg-accent-soft px-3 text-xs font-semibold text-accent sm:px-6">
          <Shield className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">{viewAsTarget.name} 시점으로 보는 중 — 읽기 전용 (발송·읽음 처리 비활성)</span>
          <button
            type="button"
            onClick={() => void endViewAs()}
            className="shrink-0 rounded-full border border-accent/40 px-2 py-0.5 text-[11px] font-bold text-accent transition-colors hover:bg-accent/10"
          >
            종료
          </button>
        </div>
      ) : null}
      <header className="flex h-16 items-center gap-2 border-b border-line bg-paper/95 px-3 backdrop-blur sm:gap-4 sm:px-6">
      <button
        ref={mobileNavButtonRef}
        type="button"
        aria-label="메뉴 열기"
        aria-controls="app-navigation"
        aria-expanded={mobileNavOpen}
        onClick={onOpenNavigation}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-2 transition-colors hover:bg-fill active:scale-[0.96] md:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>
      <form
        onSubmit={submit}
        className="flex h-10 min-w-0 w-full max-w-md items-center gap-2 rounded-full bg-fill px-3 text-ink-3 sm:px-4"
      >
        <Search className="h-[18px] w-[18px] shrink-0" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          className="min-w-0 w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
        />
      </form>
      {syncing ? (
        <LoadingStatus compact className="hidden shrink-0 whitespace-nowrap py-0 sm:flex">
          동기화 중
        </LoadingStatus>
      ) : null}
      <div className="ml-auto flex items-center gap-1">
      <button
        type="button"
        className="hidden h-10 items-center rounded-full border border-line bg-paper px-4 text-sm font-semibold text-ink-2 transition-colors hover:bg-fill hover:text-ink md:inline-flex"
      >
        Ask Mixmax
      </button>
      <button
        type="button"
        className="hidden h-10 items-center rounded-full bg-[#dca400] px-4 text-sm font-bold text-white transition-colors hover:bg-[#c99700] md:inline-flex"
      >
        Request upgrade
      </button>
      {canViewAs ? (
        <div className="relative">
          <button
            type="button"
            aria-label="대신 보기"
            aria-expanded={viewAsMenuOpen}
            onClick={() => {
              setViewAsMenuOpen((open) => !open);
              setNotificationsOpen(false);
            }}
            title="대신 보기 (Super Admin 전용)"
            className={[
              "grid h-10 w-10 place-items-center rounded-full transition-colors hover:bg-fill",
              viewAsTarget ? "text-accent" : "text-ink-2",
            ].join(" ")}
          >
            <Shield className="h-5 w-5" />
          </button>
          {viewAsMenuOpen ? (
            <div className="absolute right-0 top-12 z-30 w-[280px] overflow-hidden rounded-md border border-line bg-paper shadow-pop">
              <div className="border-b border-line px-4 py-3">
                <div className="text-sm font-bold text-ink">대신 보기</div>
                <div className="mt-0.5 text-xs text-ink-3">읽기 전용으로 다른 사용자 화면을 봅니다</div>
              </div>
              <div className="px-3 py-2">
                <input
                  value={viewAsQuery}
                  onChange={(e) => setViewAsQuery(e.target.value)}
                  placeholder="이름 또는 이메일 검색"
                  className="w-full rounded-md bg-fill px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-3"
                  autoFocus
                />
              </div>
              <div className="max-h-64 divide-y divide-line overflow-y-auto">
                {viewAsCandidates.length === 0 && viewAsMembersLoading ? (
                  <div className="px-4 py-3 text-xs text-ink-3">불러오는 중…</div>
                ) : viewAsCandidates.length === 0 ? (
                  <div className="px-4 py-3 text-xs text-ink-3">일치하는 사용자가 없습니다.</div>
                ) : (
                  viewAsCandidates.map((member) => (
                    <button
                      key={member.id}
                      type="button"
                      onClick={() => selectViewAsTarget(member)}
                      className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left hover:bg-fill"
                    >
                      <span className="truncate text-sm font-medium text-ink">{member.name}</span>
                      <span className="truncate text-xs text-ink-3">{member.email}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="relative">
        <button
          type="button"
          aria-label="알림 열기"
          aria-expanded={notificationsOpen}
          onClick={() => {
            setNotificationsOpen((open) => !open);
            setViewAsMenuOpen(false);
          }}
          className="relative grid h-10 w-10 place-items-center rounded-full text-ink-2 transition-colors hover:bg-fill"
        >
          <Bell className="h-5 w-5" />
          {totalNotificationCount > 0 ? (
            <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-danger" />
          ) : (
            <span className="absolute right-2.5 top-2.5 h-1.5 w-1.5 rounded-full bg-accent" />
          )}
        </button>
        {notificationsOpen ? (
          <div className="absolute right-0 top-12 z-30 w-[300px] overflow-hidden rounded-md border border-line bg-paper shadow-pop">
            <div className="border-b border-line px-4 py-3">
              <div className="text-sm font-bold text-ink">알림</div>
              <div className="mt-0.5 text-xs text-ink-3">Messages and review items</div>
            </div>
            <div className="divide-y divide-line">
              {canReadReviewInbox ? (
                <Link
                  href={externalFluHref("/flu/scp?tab=inbox")}
                  onClick={() => setNotificationsOpen(false)}
                  className="block px-4 py-3 hover:bg-fill"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-ink">인박스</div>
                    <NotificationCountBadge count={reviewInboxCount} urgent />
                  </div>
                  <div className="mt-0.5 text-xs text-ink-3">Items that need a human decision</div>
                </Link>
              ) : null}
              <Link
                href="/chat"
                onClick={() => setNotificationsOpen(false)}
                className="block px-4 py-3 hover:bg-fill"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-ink">Messages</div>
                  <NotificationCountBadge count={unreadMessageCount} urgent={unreadMessageCount > 0} />
                </div>
                <div className="mt-0.5 text-xs text-ink-3">Program and direct conversations</div>
              </Link>
            </div>
          </div>
        ) : null}
      </div>
      </div>
      </header>
    </div>
  );
}
