"use client";

// "미답장 인박스" (2026-09-26, 헤세 요청) — "답장 안 한 애들은 인박스에 모아두게". scp
// 사서함으로 들어온 창작자 대화 중 아직 사람 답장이 필요한 것만 서버가 걸러 내려준다
// (functions/read.ts listUnrepliedInboxHandler — RBAC·scp 스코프·조직 제외·manual-reply
// 재검증까지 서버가 끝낸 뒤의 결과만 받는다. 클라이언트는 Firestore를 직접 보지 않는다).
// 오래 기다린 순으로 이미 정렬돼 온다 — 이 컴포넌트는 표시만 한다.
//
// src/components/flu/scpAutomation/ReviewInboxPanel.tsx 와 같은 레이아웃/스코프-토큰 패턴을
// 따른다(카드+ListRow, 계정/역할 전환 시 이전 요청 결과가 새 스코프에 섞이지 않도록 토큰으로
// 막는다) — 소스가 하나뿐이라 그만큼 더 단순하다.
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Card, CardHeader } from "@/components/ui/Card";
import { ListRow } from "@/components/ui/ListRow";
import { LoadingStatus } from "@/components/ui/LoadingStatus";
import { listUnrepliedInbox, type ListUnrepliedInboxPayload, type UnrepliedInboxRow } from "@/lib/data";
import { publicCallableErrorMessage } from "@/lib/live";
import { useAuthUser, useRole } from "@/lib/role";
import { useViewAs } from "@/lib/viewAs";
import {
  isCurrentReviewInboxScopeToken,
  nextReviewInboxScopeToken,
  reviewInboxScopeKey,
  type ReviewInboxScopeToken,
} from "@/modules/review/inboxScope";
import {
  unrepliedInboxItemsFromRows,
  unrepliedInboxWaitingSinceLabel,
  type UnrepliedInboxItem,
} from "@/lib/unreplied-inbox";

const UNREPLIED_INBOX_LIMIT = 50;
export const UNREPLIED_INBOX_EMPTY_MESSAGE = "지금 답장을 기다리는 대화가 없습니다.";

// Flu conversation org-filter round 3 (coordinator gap-close, finding #8 follow-through): a single
// server scan window (functions/read.ts UNREPLIED_INBOX_MAX_SCAN_PAGES) can come back with zero
// in-scope rows even though real ones exist further down the collection — a sparse-scoped caller's
// rows buried behind hundreds of other orgs'/accounts' rows. The server exposes pageInfo.nextCursor
// exactly to resume past that window. This bounds how many EXTRA round trips the panel/badge make
// automatically before giving up and (for the panel) falling back to a manual "더 보기" — never an
// unbounded loop.
const UNREPLIED_INBOX_MAX_AUTO_CONTINUATIONS = 3;

// 30초 TTL — 벨/탭을 여러 번 열고 닫아도 그 안에서는 네트워크 재조회 없이 캐시를 쓴다
// (ReviewInboxPanel의 REVIEW_INBOX_COUNT_CACHE_TTL_MS와 같은 결, 이쪽은 갱신이 더 빈번해도
// 되는 화면이라 TTL을 짧게 둔다).
const UNREPLIED_INBOX_CACHE_TTL_MS = 30_000;
type UnrepliedInboxCacheEntry = {
  scopeKey: string;
  rows: UnrepliedInboxRow[];
  total: number;
  /** null once the scan reached the true end of the collection — see fetchUnrepliedInboxAccumulated. */
  nextCursor: string | null;
  fetchedAtMs: number;
};
const unrepliedInboxCache = new Map<string, UnrepliedInboxCacheEntry>();

function isUnrepliedInboxCacheFresh(
  cache: UnrepliedInboxCacheEntry | undefined,
  scopeKey: string,
): cache is UnrepliedInboxCacheEntry {
  return cache !== undefined && cache.scopeKey === scopeKey && Date.now() - cache.fetchedAtMs < UNREPLIED_INBOX_CACHE_TTL_MS;
}

type UnrepliedInboxFetchResult = {
  rows: UnrepliedInboxRow[];
  /** Sum of counts.total across every page THIS call actually fetched — never a full-queue
   * estimate. Still a lower bound whenever nextCursor is non-null on return. */
  total: number;
  nextCursor: string | null;
};

/**
 * Auto-continues (bounded by UNREPLIED_INBOX_MAX_AUTO_CONTINUATIONS) until a page actually returns
 * a row, or the scan is genuinely exhausted (nextCursor: null), or the bound is hit. Never claims
 * more than what this call actually scanned — a caller must check the returned nextCursor before
 * treating `total`/`rows` as complete (see handleLoadMore in UnrepliedInboxPanel for the manual
 * continuation this leaves for the caller when the bound is hit while still truncated).
 *
 * Flu conversation org-filter round 4 (codex adversarial review round 2, finding #5): sums
 * `counts.returned` (the manual-reply-filtered rows actually returned), never `counts.total` — the
 * server's `total` counts every in-scope candidate found in its scan window BEFORE removing the
 * ones a manual-reply re-check (functions/manualReplyDetection.ts) determines are already answered.
 * A badge built from `total` could count conversations that are not actually waiting on anyone.
 */
async function fetchUnrepliedInboxAccumulated(
  payload: Omit<ListUnrepliedInboxPayload, "cursor">,
): Promise<UnrepliedInboxFetchResult> {
  let rows: UnrepliedInboxRow[] = [];
  let total = 0;
  let cursor: string | undefined;
  let nextCursor: string | null = null;
  for (let attempt = 0; attempt <= UNREPLIED_INBOX_MAX_AUTO_CONTINUATIONS; attempt += 1) {
    const result = await listUnrepliedInbox({ ...payload, cursor });
    rows = result.rows;
    total += result.counts.returned;
    nextCursor = result.pageInfo.nextCursor;
    if (rows.length > 0 || !nextCursor) break;
    cursor = nextCursor;
  }
  return { rows, total, nextCursor };
}

// 2026-09-27 security fix (codex round1 finding #3): 대신 보기 중에는 대상자의 실제(제한된)
// scp 접근권으로 판정돼야 한다 — 호출자(super_admin)의 자기 자신 scp 인박스가 대신 보기
// 프리뷰에 새어 나가면 안 된다. src/app/(app)/chat/page.tsx의 동일한 role 재검증 패턴을 따른다
// (currentRole이 super_admin이 아니면 대상이 있어도 무시) — 서버(functions/read.ts
// effectiveConversationAuth)가 이 값을 다시 검증한다.
function useUnrepliedInboxViewAsParams(): { viewAsUserId?: string; viewAsEmail?: string } {
  const { role } = useRole();
  const { target, isViewingAs: viewAsFlagActive } = useViewAs();
  const isViewingAs = role === "super_admin" && viewAsFlagActive;
  return useMemo(
    () => (isViewingAs && target ? { viewAsUserId: target.userId, viewAsEmail: target.email } : {}),
    [isViewingAs, target],
  );
}

function useUnrepliedInboxScopeKey(): { scopeKey: string; viewAsParams: { viewAsUserId?: string; viewAsEmail?: string } } {
  const { role, team } = useRole();
  const authUser = useAuthUser();
  const viewAsParams = useUnrepliedInboxViewAsParams();
  const scopeKey = useMemo(() => {
    if (!authUser?.uid || role === "guest") return "";
    return reviewInboxScopeKey({
      uid: authUser.uid,
      tenantId: authUser.tenantId ?? "",
      role,
      team: team ?? "",
      viewAsUserId: viewAsParams.viewAsUserId ?? "",
    });
  }, [authUser?.tenantId, authUser?.uid, role, team, viewAsParams.viewAsUserId]);
  return { scopeKey, viewAsParams };
}

export type UnrepliedInboxCount = {
  count: number;
  /** true when the bounded auto-continuation scan (fetchUnrepliedInboxAccumulated) still had a
   * nextCursor left when it stopped — `count` is then a lower bound, not the true queue size. A
   * caller must label it as such (e.g. "37+") rather than presenting it as exact. */
  isPartial: boolean;
};

const UNREPLIED_INBOX_ZERO_COUNT: UnrepliedInboxCount = { count: 0, isPartial: false };

/** 탭 배지용 — 목록 전체를 렌더하지 않고 건수만 필요할 때. */
export function useUnrepliedInboxCount(): UnrepliedInboxCount {
  const { scopeKey, viewAsParams } = useUnrepliedInboxScopeKey();
  const [state, setState] = useState<UnrepliedInboxCount>(() => {
    const cached = scopeKey ? unrepliedInboxCache.get(scopeKey) : undefined;
    return scopeKey && isUnrepliedInboxCacheFresh(cached, scopeKey)
      ? { count: cached.total, isPartial: cached.nextCursor !== null }
      : UNREPLIED_INBOX_ZERO_COUNT;
  });
  const latestScopeKeyRef = useRef(scopeKey);

  useEffect(() => {
    latestScopeKeyRef.current = scopeKey;
    if (!scopeKey) {
      setState(UNREPLIED_INBOX_ZERO_COUNT);
      return;
    }
    const cached = unrepliedInboxCache.get(scopeKey);
    if (isUnrepliedInboxCacheFresh(cached, scopeKey)) {
      setState({ count: cached.total, isPartial: cached.nextCursor !== null });
      return;
    }
    let cancelled = false;
    fetchUnrepliedInboxAccumulated({ limit: UNREPLIED_INBOX_LIMIT, ...viewAsParams }).then((result) => {
      if (cancelled || latestScopeKeyRef.current !== scopeKey) return;
      unrepliedInboxCache.set(scopeKey, { scopeKey, rows: result.rows, total: result.total, nextCursor: result.nextCursor, fetchedAtMs: Date.now() });
      setState({ count: result.total, isPartial: result.nextCursor !== null });
    }).catch(() => {
      if (!cancelled && latestScopeKeyRef.current === scopeKey) setState(UNREPLIED_INBOX_ZERO_COUNT);
    });
    return () => {
      cancelled = true;
    };
  }, [scopeKey, viewAsParams]);

  return state;
}

export function UnrepliedInboxPanel() {
  const { scopeKey, viewAsParams } = useUnrepliedInboxScopeKey();
  const latestRequestRef = useRef<ReviewInboxScopeToken>({ scopeKey: "", generation: 0 });
  const [state, setState] = useState<{ scopeKey: string; rows: UnrepliedInboxRow[]; total: number; nextCursor: string | null }>({
    scopeKey: "",
    rows: [],
    total: 0,
    nextCursor: null,
  });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const token = nextReviewInboxScopeToken(latestRequestRef.current, scopeKey);
    latestRequestRef.current = token;
    setState({ scopeKey, rows: [], total: 0, nextCursor: null });
    if (!scopeKey) {
      setLoading(false);
      setError("");
      return;
    }
    const cached = unrepliedInboxCache.get(scopeKey);
    if (isUnrepliedInboxCacheFresh(cached, scopeKey)) {
      setState({ scopeKey, rows: cached.rows, total: cached.total, nextCursor: cached.nextCursor });
      setLoading(false);
      setError("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    fetchUnrepliedInboxAccumulated({ limit: UNREPLIED_INBOX_LIMIT, ...viewAsParams }).then((result) => {
      if (cancelled || !isCurrentReviewInboxScopeToken(latestRequestRef.current, token)) return;
      unrepliedInboxCache.set(scopeKey, { scopeKey, rows: result.rows, total: result.total, nextCursor: result.nextCursor, fetchedAtMs: Date.now() });
      setState({ scopeKey, rows: result.rows, total: result.total, nextCursor: result.nextCursor });
      setLoading(false);
    }).catch((caught) => {
      if (cancelled || !isCurrentReviewInboxScopeToken(latestRequestRef.current, token)) return;
      setState({ scopeKey, rows: [], total: 0, nextCursor: null });
      setError(publicCallableErrorMessage(caught, "미답장 인박스를 불러오지 못했습니다."));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [scopeKey, viewAsParams]);

  // Flu conversation org-filter round 3: the auto-continuation above already exhausted its bound
  // (UNREPLIED_INBOX_MAX_AUTO_CONTINUATIONS) while pageInfo.nextCursor was still non-null — a
  // manual escape hatch reaches whatever remains beyond that, appending to the rows already shown
  // (never replacing them, so nothing already-read disappears from the list).
  const handleLoadMore = () => {
    const activeScopeKey = scopeKey;
    if (!activeScopeKey || !state.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    listUnrepliedInbox({ limit: UNREPLIED_INBOX_LIMIT, cursor: state.nextCursor, ...viewAsParams }).then((result) => {
      if (latestRequestRef.current.scopeKey !== activeScopeKey) return;
      setState((prev) => {
        if (prev.scopeKey !== activeScopeKey) return prev;
        const merged = {
          scopeKey: prev.scopeKey,
          rows: [...prev.rows, ...result.rows],
          // counts.returned, not counts.total — see fetchUnrepliedInboxAccumulated's doc comment.
          total: prev.total + result.counts.returned,
          nextCursor: result.pageInfo.nextCursor,
        };
        unrepliedInboxCache.set(activeScopeKey, { ...merged, fetchedAtMs: Date.now() });
        return merged;
      });
      setLoadingMore(false);
    }).catch((caught) => {
      if (latestRequestRef.current.scopeKey !== activeScopeKey) return;
      setError(publicCallableErrorMessage(caught, "추가 항목을 불러오지 못했습니다."));
      setLoadingMore(false);
    });
  };

  const scopedRows = state.scopeKey === scopeKey ? state.rows : [];
  const items = useMemo(() => unrepliedInboxItemsFromRows(scopedRows), [scopedRows]);
  const canLoadMore = state.scopeKey === scopeKey && state.nextCursor !== null;

  return (
    <Card data-testid="unreplied-inbox-panel">
      <CardHeader
        title="미답장 인박스"
        desc="scp 사서함으로 들어온 창작자 메일 중 아직 답장하지 못한 대화를 오래 기다린 순서로 모았습니다."
      />
      <div>
        {error ? (
          <div className="border-b border-danger/20 bg-danger-soft px-4 py-3 text-sm font-medium text-danger" role="alert">
            {error}
          </div>
        ) : null}
        {loading && items.length === 0 ? (
          <LoadingStatus className="px-4 py-6">미답장 인박스를 불러오는 중</LoadingStatus>
        ) : items.length === 0 ? (
          // Flu conversation org-filter round 4 (codex adversarial review round 2, finding #5): the
          // bounded auto-continuation above can exhaust its bound with zero rows found yet still
          // have a remaining nextCursor (a sparse org's rows buried further down than the bound
          // reached) — this must not present as a dead end. "계속 찾기" resumes the SAME scan
          // handleLoadMore already implements, just from the empty state instead of the row list.
          <div className="px-5 py-9 text-center text-sm text-ink-3">
            <p>{UNREPLIED_INBOX_EMPTY_MESSAGE}</p>
            {canLoadMore ? (
              <div className="mt-3">
                <UnrepliedInboxLoadMoreButton loading={loadingMore} onClick={handleLoadMore} label="계속 찾기" />
              </div>
            ) : null}
          </div>
        ) : (
          <>
            {items.map((item) => <UnrepliedInboxRowView key={item.id} item={item} />)}
            {canLoadMore ? (
              <div className="px-5 py-4">
                <UnrepliedInboxLoadMoreButton loading={loadingMore} onClick={handleLoadMore} label="더 보기" />
              </div>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}

function UnrepliedInboxLoadMoreButton({
  loading,
  onClick,
  label,
}: {
  loading: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="rounded-full border border-line bg-fill px-3 py-1.5 text-xs font-semibold text-ink-2 hover:bg-fill/70 disabled:opacity-60"
    >
      {loading ? "찾는 중…" : label}
    </button>
  );
}

function UnrepliedInboxRowView({ item }: { item: UnrepliedInboxItem }) {
  return (
    <ListRow
      title={
        <>
          {/* item.handle 은 ReviewInboxPanel(짧은 @유튜브핸들)과 달리 이메일 주소일 때가 많다
              (긴 문자열). shrink-0 인 handle span 옆에서 name span 이 overflow:hidden(=truncate)
              이면 flex 최소폭 자동 계산이 0 이 돼(CSS "overflow != visible → automatic min size
              0" 규칙) 이름이 통째로 0폭으로 눌린다 — flex-1 min-w-0 으로 이름에 우선권을 주고,
              handle 은 shrink-0 대신 최대폭 캡만 둔다. */}
          <span className="min-w-0 flex-1 truncate">{item.who}</span>
          {item.handle ? <span className="max-w-[45%] shrink truncate text-xs font-normal text-ink-3">{item.handle}</span> : null}
        </>
      }
      subtitle={
        <span className="block">
          <span className="block truncate">{item.reason}</span>
          {item.draftPreview ? (
            <span className="mt-0.5 block truncate text-ink-4">초안: {item.draftPreview}</span>
          ) : null}
        </span>
      }
      meta={
        <div className="flex items-center justify-end gap-2">
          <Badge tone={item.autoReplyStatus === "draft_only" ? "info" : "warn"}>
            {item.autoReplyStatus === "draft_only" ? "초안 대기" : "답장 대기"}
          </Badge>
          <span className="whitespace-nowrap text-xs text-ink-3">{unrepliedInboxWaitingSinceLabel(item.waitingSinceIso)}</span>
        </div>
      }
      href={item.href}
      metaInteractive={false}
    />
  );
}
