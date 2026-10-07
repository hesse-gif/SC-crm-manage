"use client";

// 2026-09-17 [헤세] — 콘텐츠 검수 "인박스" 탭.
//
// 애매한 건(영상 검수 human_review_required·이의제기 / 자동응답 못한 문의 / 신청자 자격 human_review)
// 을 한 화면에 모은다 — "질문하고 문제를 해결하려는 사람 : 해결은 AI가" 라는 팀 미션대로, 애매한
// 건이 조용히 묻히지 않게 바로 보여준다. 행 만들기/정렬/사유 라벨은 순수 모듈
// (src/modules/review/inbox.ts)이 갖고, 이 컴포넌트는 세 소스를 불러와 그 모듈에 넘기기만 한다.
//
// 데이터 소스 3종 (전부 기존 콜러블 — 새 콜러블 없음):
//   ① listScpVideoReviewStates — scp_video_review_state 전체(프로그램 무관, 최대 몇 페이지).
//   ② useLiveReviews — reviews 컬렉션 실시간 구독(이미 앱 전역이 쓰는 훅, 새 구독 아님).
//   ③ listApplicationManageInbox({filter:"qualification_human_review"}) — Task-95 자격 판정
//      human_review 행만(기존 콜러블에 최소 필터 추가, applicationManagementStore.ts 참고).

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Card, CardHeader } from "@/components/ui/Card";
import { ListRow } from "@/components/ui/ListRow";
import { LoadingStatus } from "@/components/ui/LoadingStatus";
import {
  listApplicationManageInbox,
  listScpVideoReviewStates,
  ROLES,
  type Role,
  type ReviewItem,
  type ScpVideoReviewStateRow,
} from "@/lib/data";
import { flagEmojiFromIsoCode, isDisplayableIsoCountryCode } from "@/lib/countryFlag";
import { publicCallableErrorMessage, useLiveReviews } from "@/lib/live";
import { useAuthUser, useRole } from "@/lib/role";
import { useViewAs } from "@/lib/viewAs";
import {
  isCurrentReviewInboxScopeToken,
  nextReviewInboxScopeToken,
  reviewInboxScopeKey,
  type ReviewInboxScopeToken,
} from "@/modules/review/inboxScope";
import {
  REVIEW_INBOX_EMPTY_MESSAGE,
  buildReviewInboxItems,
  reviewInboxWaitingSinceLabel,
  type ReviewInboxItem,
} from "@/modules/review/inbox";

// 보조 메타 줄 — 구독자 수·국가 같은 "판단 근거" 값만. 소스에 없으면 그 자리를 비운다
// (빈 값을 "—" 로 채우지 않는다 — 없는 값을 있는 것처럼 보이게 하지 않는다).
function inboxItemSecondaryMeta(item: ReviewInboxItem): string {
  const parts: string[] = [];
  if (typeof item.subscriberCount === "number") {
    parts.push(`구독자 ${item.subscriberCount.toLocaleString("ko-KR")}명`);
  }
  // ISO alpha-2 가 검증된 코드만 표시한다 — 자가신고 자유텍스트("KORE", "South Korea" 등)를
  // 국가 코드처럼 날것으로 보여주지 않는다(값 자체는 payload 에 남아 다른 소비자가 쓸 수 있다).
  if (item.country && isDisplayableIsoCountryCode(item.country)) {
    const flag = flagEmojiFromIsoCode(item.country);
    parts.push(flag ? `${flag} ${item.country}` : item.country);
  }
  return parts.join(" · ");
}

const VIDEO_STATES_PAGE_LIMIT = 200;
const APPLICANT_INBOX_LIMIT = 200;

async function listAllScpVideoReviewStatesForInbox(): Promise<ScpVideoReviewStateRow[]> {
  const states: ScpVideoReviewStateRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await listScpVideoReviewStates({ limit: VIDEO_STATES_PAGE_LIMIT, cursor });
    states.push(...page.states);
    cursor = page.nextCursor || undefined;
  } while (cursor);
  return states;
}

// [적대 리뷰 MEDIUM-5] Topbar 벨은 열고 닫을 때마다 `enabled` 가 다시 true 가 되어 두 이펙트를
// 재실행한다 — 특히 listAllScpVideoReviewStatesForInbox 는 상한 없는 페이지네이션(최대 몇
// 페이지)이라, 벨을 여러 번 여닫으면 그때마다 그 전체 조회가 재실행되는 "refetch storm"이 된다.
// 모듈 레벨 캐시(컴포넌트 인스턴스가 아니라 모듈 스코프 — 탭 전체에서 공유되고 언마운트에도
// 살아남는다) + 60초 TTL로, TTL 안에서 벨을 다시 열면 네트워크 조회 없이 캐시를 그대로 쓴다.
// lazy-on-open 은 그대로 유지 — enabled=false 인 동안은 여전히 아무 것도 불러오지 않는다.
const REVIEW_INBOX_COUNT_CACHE_TTL_MS = 60_000;
type ReviewInboxCountCacheEntry<T> = { scopeKey: string; data: T; fetchedAtMs: number };
const reviewInboxVideoRowsCache = new Map<string, ReviewInboxCountCacheEntry<ScpVideoReviewStateRow[]>>();
const reviewInboxApplicantRowsCache = new Map<string, ReviewInboxCountCacheEntry<Record<string, unknown>[]>>();

function isReviewInboxCountCacheFresh<T>(
  cache: ReviewInboxCountCacheEntry<T> | undefined,
  scopeKey: string,
): cache is ReviewInboxCountCacheEntry<T> {
  return cache !== undefined
    && cache.scopeKey === scopeKey
    && Date.now() - cache.fetchedAtMs < REVIEW_INBOX_COUNT_CACHE_TTL_MS;
}

function canReadPrivilegedReviewInbox(role: Role): boolean {
  return ROLES[role].rank >= ROLES.manager.rank;
}

// 2026-09-17 [헤세] — Topbar 알림 "인박스" 배지용. 영상·신청자 소스는 이 패널과 같은 콜러블을
// 쓰지만(새 콜러블 없음), Topbar 는 모든 페이지에 항상 떠 있는 전역 셸이라 무조건 로드하면 안 된다
// — `enabled` 가 true(알림 드롭다운을 실제로 열었을 때)일 때만 그 두 소스를 불러온다. 문의 소스는
// 이미 앱 전역이 구독하는 reviews 실시간 데이터라 추가 비용이 없어 항상 반영한다.
export function useReviewInboxCount(enabled: boolean): number {
  const reviewItems = useLiveReviews<ReviewItem>([]);
  const { role, team } = useRole();
  const authUser = useAuthUser();
  const { target: viewAsTarget } = useViewAs();
  const activeViewAsTarget = role === "super_admin" ? viewAsTarget : null;
  const canReadInboxRows = canReadPrivilegedReviewInbox(role) && Boolean(authUser?.uid);
  const canFetchPrivilegedRows = enabled && canReadInboxRows;
  const scopeKey = useMemo(() => {
    if (!authUser?.uid) return "";
    return reviewInboxScopeKey({
      uid: authUser.uid,
      tenantId: authUser.tenantId ?? "",
      role,
      team: team ?? "",
      viewAsUserId: activeViewAsTarget?.userId ?? "",
    });
  }, [activeViewAsTarget?.userId, authUser?.tenantId, authUser?.uid, role, team]);
  const latestScopeKeyRef = useRef(scopeKey);
  const [videoRows, setVideoRows] = useState<ScpVideoReviewStateRow[]>(() => {
    const initialScopeKey = scopeKey;
    return initialScopeKey && isReviewInboxCountCacheFresh(reviewInboxVideoRowsCache.get(initialScopeKey), initialScopeKey)
      ? reviewInboxVideoRowsCache.get(initialScopeKey)?.data ?? []
      : [];
  });
  const [applicantRows, setApplicantRows] = useState<Record<string, unknown>[]>(() => {
    const initialScopeKey = scopeKey;
    return initialScopeKey && isReviewInboxCountCacheFresh(reviewInboxApplicantRowsCache.get(initialScopeKey), initialScopeKey)
      ? reviewInboxApplicantRowsCache.get(initialScopeKey)?.data ?? []
      : [];
  });

  useEffect(() => {
    latestScopeKeyRef.current = scopeKey;
    if (!canFetchPrivilegedRows || !scopeKey) {
      setVideoRows([]);
      setApplicantRows([]);
      return;
    }
    const cachedVideoRows = reviewInboxVideoRowsCache.get(scopeKey);
    const cachedApplicantRows = reviewInboxApplicantRowsCache.get(scopeKey);
    setVideoRows(isReviewInboxCountCacheFresh(cachedVideoRows, scopeKey) ? cachedVideoRows.data : []);
    setApplicantRows(isReviewInboxCountCacheFresh(cachedApplicantRows, scopeKey) ? cachedApplicantRows.data : []);
  }, [canFetchPrivilegedRows, scopeKey]);

  useEffect(() => {
    if (!canFetchPrivilegedRows || !scopeKey) return;
    const cached = reviewInboxVideoRowsCache.get(scopeKey);
    if (isReviewInboxCountCacheFresh(cached, scopeKey)) {
      setVideoRows(cached.data);
      return;
    }
    let cancelled = false;
    listAllScpVideoReviewStatesForInbox().then((states) => {
      if (cancelled || latestScopeKeyRef.current !== scopeKey) return;
      reviewInboxVideoRowsCache.set(scopeKey, { scopeKey, data: states, fetchedAtMs: Date.now() });
      setVideoRows(states);
    }).catch(() => {
      if (!cancelled && latestScopeKeyRef.current === scopeKey) setVideoRows([]);
    });
    return () => {
      cancelled = true;
    };
  }, [canFetchPrivilegedRows, scopeKey]);

  useEffect(() => {
    if (!canFetchPrivilegedRows || !scopeKey) return;
    const cached = reviewInboxApplicantRowsCache.get(scopeKey);
    if (isReviewInboxCountCacheFresh(cached, scopeKey)) {
      setApplicantRows(cached.data);
      return;
    }
    let cancelled = false;
    listApplicationManageInbox({ limit: APPLICANT_INBOX_LIMIT, filter: "qualification_human_review" }).then((result) => {
      if (cancelled || latestScopeKeyRef.current !== scopeKey) return;
      const rows = result.inbox ?? [];
      reviewInboxApplicantRowsCache.set(scopeKey, { scopeKey, data: rows, fetchedAtMs: Date.now() });
      setApplicantRows(rows);
    }).catch(() => {
      if (!cancelled && latestScopeKeyRef.current === scopeKey) setApplicantRows([]);
    });
    return () => {
      cancelled = true;
    };
  }, [canFetchPrivilegedRows, scopeKey]);

  return buildReviewInboxItems({
    videoRows: canFetchPrivilegedRows ? videoRows : [],
    mailRows: canReadInboxRows ? reviewItems : [],
    applicantRows: canFetchPrivilegedRows ? applicantRows : [],
  }).length;
}

export function ReviewInboxPanel() {
  const reviewItems = useLiveReviews<ReviewItem>([]);
  const { role, team } = useRole();
  const authUser = useAuthUser();
  const { target: viewAsTarget } = useViewAs();
  const activeViewAsTarget = role === "super_admin" ? viewAsTarget : null;
  const canReadInboxRows = canReadPrivilegedReviewInbox(role) && Boolean(authUser?.uid);
  const canFetchPrivilegedRows = canReadInboxRows;
  const scopeKey = useMemo(() => {
    if (!authUser?.uid) return "";
    return reviewInboxScopeKey({
      uid: authUser.uid,
      tenantId: authUser.tenantId ?? "",
      role,
      team: team ?? "",
      viewAsUserId: activeViewAsTarget?.userId ?? "",
    });
  }, [activeViewAsTarget?.userId, authUser?.tenantId, authUser?.uid, role, team]);
  const latestVideoPanelRequestRef = useRef<ReviewInboxScopeToken>({ scopeKey: "", generation: 0 });
  const latestApplicantPanelRequestRef = useRef<ReviewInboxScopeToken>({ scopeKey: "", generation: 0 });
  const [videoState, setVideoState] = useState<{ scopeKey: string; rows: ScpVideoReviewStateRow[] }>({ scopeKey: "", rows: [] });
  const [videoLoading, setVideoLoading] = useState(canFetchPrivilegedRows);
  const [videoError, setVideoError] = useState("");
  const [applicantState, setApplicantState] = useState<{ scopeKey: string; rows: Record<string, unknown>[] }>({ scopeKey: "", rows: [] });
  const [applicantLoading, setApplicantLoading] = useState(canFetchPrivilegedRows);
  const [applicantError, setApplicantError] = useState("");

  useEffect(() => {
    const token = nextReviewInboxScopeToken(latestVideoPanelRequestRef.current, scopeKey);
    latestVideoPanelRequestRef.current = token;
    setVideoState({ scopeKey, rows: [] });
    if (!canFetchPrivilegedRows || !scopeKey) {
      setVideoLoading(false);
      setVideoError("");
      return;
    }
    let cancelled = false;
    setVideoLoading(true);
    setVideoError("");
    listAllScpVideoReviewStatesForInbox().then((states) => {
      if (cancelled || !isCurrentReviewInboxScopeToken(latestVideoPanelRequestRef.current, token)) return;
      setVideoState({ scopeKey, rows: states });
      setVideoLoading(false);
    }).catch((caught) => {
      if (cancelled || !isCurrentReviewInboxScopeToken(latestVideoPanelRequestRef.current, token)) return;
      setVideoState({ scopeKey, rows: [] });
      setVideoError(publicCallableErrorMessage(caught, "영상 검수 대기 목록을 불러오지 못했습니다."));
      setVideoLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [canFetchPrivilegedRows, scopeKey]);

  useEffect(() => {
    const token = nextReviewInboxScopeToken(latestApplicantPanelRequestRef.current, scopeKey);
    latestApplicantPanelRequestRef.current = token;
    setApplicantState({ scopeKey, rows: [] });
    if (!canFetchPrivilegedRows || !scopeKey) {
      setApplicantLoading(false);
      setApplicantError("");
      return;
    }
    let cancelled = false;
    setApplicantLoading(true);
    setApplicantError("");
    listApplicationManageInbox({ limit: APPLICANT_INBOX_LIMIT, filter: "qualification_human_review" }).then((result) => {
      if (cancelled || !isCurrentReviewInboxScopeToken(latestApplicantPanelRequestRef.current, token)) return;
      setApplicantState({ scopeKey, rows: result.inbox ?? [] });
      setApplicantLoading(false);
    }).catch((caught) => {
      if (cancelled || !isCurrentReviewInboxScopeToken(latestApplicantPanelRequestRef.current, token)) return;
      setApplicantState({ scopeKey, rows: [] });
      setApplicantError(publicCallableErrorMessage(caught, "신청자 자격 검토 대기열을 불러오지 못했습니다."));
      setApplicantLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [canFetchPrivilegedRows, scopeKey]);

  const scopedVideoRows = videoState.scopeKey === scopeKey ? videoState.rows : [];
  const scopedApplicantRows = applicantState.scopeKey === scopeKey ? applicantState.rows : [];
  const loading = videoLoading || applicantLoading;
  const items = buildReviewInboxItems({
    videoRows: canFetchPrivilegedRows ? scopedVideoRows : [],
    mailRows: canReadInboxRows ? reviewItems : [],
    applicantRows: canFetchPrivilegedRows ? scopedApplicantRows : [],
    reviewBasePath: "/flu/scp",
  });

  return (
    <Card data-testid="review-inbox-panel">
      <CardHeader
        title="인박스"
        desc="영상·문의·신청자 중 사람 판단이 필요한 건을 대기 시간이 긴 순서로 모았습니다."
      />
      <div>
        {!canFetchPrivilegedRows ? (
          <div className="border-b border-line bg-fill px-4 py-3 text-sm font-medium text-ink-3" role="status">
            매니저 이상 권한에서만 검수 인박스를 확인할 수 있습니다.
          </div>
        ) : null}
        {videoError ? (
          <div className="border-b border-danger/20 bg-danger-soft px-4 py-3 text-sm font-medium text-danger" role="alert">
            {videoError}
          </div>
        ) : null}
        {applicantError ? (
          <div className="border-b border-danger/20 bg-danger-soft px-4 py-3 text-sm font-medium text-danger" role="alert">
            {applicantError}
          </div>
        ) : null}
        {loading && items.length === 0 ? (
          <LoadingStatus className="px-4 py-6">인박스를 불러오는 중</LoadingStatus>
        ) : items.length === 0 ? (
          <div className="px-5 py-9 text-center text-sm text-ink-3">
            {REVIEW_INBOX_EMPTY_MESSAGE}
          </div>
        ) : (
          items.map((item) => {
            const secondaryMeta = inboxItemSecondaryMeta(item);
            return (
              <ListRow
                key={item.id}
                title={
                  <>
                    <span className="truncate">{item.who}</span>
                    {item.handle ? (
                      <span className="shrink-0 truncate text-xs font-normal text-ink-3">{item.handle}</span>
                    ) : null}
                  </>
                }
                subtitle={
                  <span className="block">
                    {secondaryMeta ? <span className="block truncate">{secondaryMeta}</span> : null}
                    <span className="block truncate">{item.reason}</span>
                  </span>
                }
                meta={
                  <div className="flex items-center justify-end gap-2">
                    <Badge tone="warn">{item.typeLabel}</Badge>
                    <span className="whitespace-nowrap text-xs text-ink-3">{reviewInboxWaitingSinceLabel(item.waitingSinceIso)}</span>
                  </div>
                }
                href={item.href || undefined}
                metaInteractive={false}
              />
            );
          })
        )}
      </div>
    </Card>
  );
}
