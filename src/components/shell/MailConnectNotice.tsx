"use client";

import { useEffect, useRef, useState } from "react";
import { beginMailOAuth, getMailOAuthStatus, setUserPreference } from "@/lib/data";
import { useAuthProfile, useRole } from "@/lib/role";
import { mailSenderPolicyMessage } from "@/lib/mail-sender-policy";
import { useOrgContext, useOrgContextScopeKey, useInvalidateOrgContext } from "@/lib/useNavPreset";
import { useViewAs } from "@/lib/viewAs";

// PLAN-ORG-MAIL-IDENTITY Slice 5 — dismissible "메일 연결(선택)" notice. Never shown to
// guests (§ UX-P1-019: no tool/model/internal-infra names, plain language only). Dismiss state
// is server-side (functions/userPreferences.ts user_preferences/{uid}) so it survives a refresh
// or a new device — never localStorage (SEC-P0-004: no client Firestore writes either way).
//
// Rendered inside the Sidebar's bottom slot (not the main column) as a compact, non-floating
// card — a `fixed` toast here previously intercepted pointer events on page-header primary
// actions (2026-09-10 regression: e2e/program-workflow.spec.ts, flu-country-html-workflow.spec.ts
// timed out clicking "새 프로그램"). See Sidebar.tsx for the collapsed/mobile-drawer handling.
export function MailConnectNotice() {
  const { role } = useRole();
  const { email } = useAuthProfile();
  // Flu/Task-42 shared org-context projection (useNavPreset.ts → org-context-cache.ts): one
  // in-flight/fresh getMyOrgContext per auth identity + viewAs target, so this notice joins the
  // same request as Sidebar/chat instead of issuing a guaranteed second call on mount. A
  // super_admin "대신 보기" scope resolves the target's projection like every other consumer;
  // null means still unresolved or the fetch failed — either way the notice stays hidden.
  const orgContext = useOrgContext();
  const orgContextScopeKey = useOrgContextScopeKey();
  const invalidateOrgContext = useInvalidateOrgContext();
  // While a super_admin "대신 보기" session is active the projection above is the TARGET's
  // (functions/mailAccountCallables.ts getMyOrgContext resolves linked/dismissed/
  // personalMailConnectAllowed for the target uid), but getMailOAuthStatus/beginMailOAuth with
  // { self: true } are caller-scoped — the banner would describe the target's mailbox while the
  // 연결 button connected the admin's own. Same gate idiom as chat page.tsx: suppress the notice
  // entirely rather than let an admin act on the target's behalf.
  const { isViewingAs: viewAsFlagActive } = useViewAs();
  const isViewingAs = role === "super_admin" && viewAsFlagActive;
  const [visible, setVisible] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState("개인 메일함을 연결하면 내 메일 기록이 Chat에 표시됩니다 (선택)");

  // codex final-gate round 10 (HIGH) — visible/noticeMessage above are derived from orgContext via
  // the async effect below (getMailOAuthStatus must resolve first), so a real identity/viewAs
  // switch (round 9's fix already corrects orgContext ITSELF synchronously during render) can
  // still paint this component's PREVIOUS scope's stale visible/noticeMessage — including an
  // active "연결" button — for at least one committed frame, since this effect only runs AFTER
  // that render commits. Fail closed (hide, not guess) synchronously in the render body the moment
  // the scope changes, exactly matching useNavPreset.ts's own "adjust state during rendering" fix.
  // codex final-gate round 11 (LOW) — role is folded into the tracked signature too: a same-uid
  // downgrade to guest doesn't change orgContextScopeKey (that key is identity/viewAs only), so
  // without this the stale banner could still paint until the visibility effect below re-runs.
  const noticeScopeSignature = `${orgContextScopeKey}|${role}`;
  const [scopeSignatureForNotice, setScopeSignatureForNotice] = useState(noticeScopeSignature);
  if (scopeSignatureForNotice !== noticeScopeSignature) {
    setScopeSignatureForNotice(noticeScopeSignature);
    setVisible(false);
  }

  // codex final-gate round 11 (MEDIUM) — connect() below awaits beginMailOAuth() before
  // navigating via window.location.assign(). If the identity/viewAs scope changes while that
  // request is in flight (sign-out, account switch, or a viewAs session starting), the response
  // (a consentUrl the server built for the DEPARTED scope's caller) would still be an obsolete
  // redirect for whoever is signed in now. A ref (not orgContextScopeKey directly) is required
  // here because connect() is a plain closure re-created each render — reading a `const` from that
  // render's own scope inside an async continuation would still give the value captured at click
  // time, not the live value when the response arrives; a ref is deliberately kept in sync with
  // every render's most recent orgContextScopeKey so `.current` is always fresh at that later
  // point. Scoped to identity/viewAs only (not role) — a same-uid role change mid-flight does not
  // invalidate the caller's own pending OAuth flow.
  const orgContextScopeKeyRef = useRef(orgContextScopeKey);
  orgContextScopeKeyRef.current = orgContextScopeKey;
  // codex final-gate round 12 (MEDIUM) — orgContextScopeKeyRef above only updates WHILE this
  // component renders. If it unmounts entirely (e.g. a real logout swaps the whole authenticated
  // shell for the login screen) while beginMailOAuth() is still in flight, the ref simply stops
  // being touched and is left holding whatever scope key was current at the last render — not a
  // signal that the identity/component are gone. The scope-mismatch check above would then see no
  // change and still navigate. A dedicated mounted flag, set false only in an unmount cleanup, is
  // the reliable "has anything about this caller's context gone away" signal.
  //
  // codex final-gate round 13 (MEDIUM) — the setup phase must also reset the ref to true, not just
  // the cleanup set it to false: this repo runs React Strict Mode (next.config.mjs), which
  // deliberately replays effect setup -> cleanup -> setup once in development specifically to
  // surface bugs like this. Without the reset here, that replay's cleanup would leave the ref
  // permanently false for the remaining lifetime of an otherwise still-fully-mounted component,
  // silently discarding every real connect() response and leaving "연결 중" (connecting) stuck.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (role === "guest" || !email || isViewingAs || !orgContext) {
      setVisible(false);
      return;
    }
    let cancelled = false;
    setConnectError(null);
    getMailOAuthStatus({ self: true })
      .then((oauthStatus) => {
        if (cancelled) return;
        // Flu/Task-48: an org that is not (or no longer) allowed to self-connect a personal
        // mailbox never sees this banner at all — server-verified (personalMailConnectAllowed),
        // never inferred client-side. A revoked credential still gets the banner so the owner
        // can repair it; `linked` alone is not treated as current provider health.
        const context = orgContext;
        const needsConnection = !context.linked
          || !oauthStatus?.linked
          || oauthStatus.status === "revoked";
        const requiresPersonalConnection = context.senderBlockedReason === "personal_connection_required";
        setNoticeMessage(
          context.orgResolutionStatus === "unresolved"
            ? "현재 계정은 Peoply 팀에 매핑되지 않았습니다. 공유 계정은 자동 배정되지 않으며, 개인 메일을 연결하면 발신할 수 있습니다."
            : context.orgResolutionStatus === "directory_unavailable"
              ? `${mailSenderPolicyMessage(context)} 개인 메일 연결 여부도 함께 확인해 주세요.`
              : requiresPersonalConnection
                ? "현재 팀은 개인 메일 연결이 필요합니다. 연결하면 Chat에서 메일 기록을 보고 발송할 수 있습니다."
                : context.senderBlockedReason === "org_mail_account_unavailable"
                  ? "현재 팀 공유 메일 계정을 사용할 수 없습니다. 개인 메일을 연결하면 발신할 수 있습니다."
                  : "개인 메일함을 연결하면 내 메일 기록이 Chat에 표시됩니다 (선택)",
        );
        // `!context.viewingAs` repeats the view-as gate against the server-verified marker on the
        // projection itself (data.ts MyOrgContextEnvelope.viewingAs): during the commit right
        // after a "대신 보기" session ends, this hook can still hold the target's projection for
        // one render before useOrgContext clears it — a projection belonging to someone else must
        // never drive a caller-scoped OAuth connect.
        setVisible(
          needsConnection
          && !context.mailConnectNoticeDismissed
          && context.personalMailConnectAllowed
          && !context.viewingAs,
        );
      })
      .catch(() => {
        if (!cancelled) setVisible(false);
      });
    return () => { cancelled = true; };
  }, [role, email, isViewingAs, orgContext]);

  if (!visible) return null;

  async function connect() {
    const connectScopeKey = orgContextScopeKeyRef.current;
    setConnectError(null);
    setConnecting(true);
    try {
      const response = await beginMailOAuth({ self: true });
      // codex final-gate round 11 (MEDIUM) — the identity/viewAs scope changed while this request
      // was in flight (sign-out, account switch, or a viewAs session starting): the consentUrl the
      // server just built was for the DEPARTED caller, not whoever is signed in now. Drop it
      // instead of navigating away on their behalf with an obsolete redirect.
      //
      // codex final-gate round 12 (MEDIUM) — orgContextScopeKeyRef only updates while this
      // component renders; a real logout can unmount it entirely before this response arrives,
      // leaving the ref stuck at its last-rendered (still "unchanged") value. isMountedRef is set
      // in an unmount cleanup regardless of rendering, so it catches that case too.
      if (!isMountedRef.current || orgContextScopeKeyRef.current !== connectScopeKey) return;
      if (response.ok && response.consentUrl) {
        window.location.assign(response.consentUrl);
        return;
      }
      if (!response.ok) {
        setConnectError(mailOAuthErrorLabel(response.error?.code ?? response.error?.kind));
      } else {
        setConnectError("메일 계정 연결을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      }
    } catch {
      if (isMountedRef.current) {
        setConnectError("메일 계정 연결을 시작하지 못했습니다. 관리자 화면에서 서버 설정과 계정 매핑을 확인해 주세요.");
      }
    } finally {
      if (isMountedRef.current) setConnecting(false);
    }
  }

  async function dismiss() {
    setVisible(false);
    try {
      await setUserPreference({ key: "mailConnectNoticeDismissedAt" });
      // The dismissal feeds back into this scope's projection (mailConnectNoticeDismissed).
      // Without invalidation a sidebar collapse/expand remount inside the 60s TTL would serve the
      // pre-write cache entry and re-show the banner the user just dismissed.
      invalidateOrgContext();
    } catch {
      // 2026-09-10 adversarial review LOW-10: persisting the dismissal failed — the banner
      // stays hidden for this session (setVisible above already applied) even though it may
      // reappear on the next load since the preference never saved server-side. Nothing
      // sensitive to log here (SEC-P0-009).
    }
  }

  return (
    <div
      role="status"
      data-testid="mail-connect-notice"
      className="mx-2 mb-2 flex flex-col gap-2 rounded-lg border border-line bg-accent-soft p-3 text-xs text-ink"
    >
      <span>{noticeMessage}</span>
      {connectError && (
        <p className="rounded-md border border-danger/30 bg-danger-soft px-2.5 py-2 leading-5 text-danger" role="alert">
          {connectError}
        </p>
      )}
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={connect}
          disabled={connecting}
          className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {connecting ? "연결 중" : connectError ? "다시 연결" : "연결"}
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="rounded-md px-2.5 py-1 text-[11px] font-semibold text-ink-3 transition-colors hover:bg-fill"
        >
          나중에
        </button>
      </div>
    </div>
  );
}

function mailOAuthErrorLabel(code: string | undefined) {
  const labels: Record<string, string> = {
    not_configured: "개인 메일 연결 서버 설정이 아직 준비되지 않았습니다. 관리자에게 OAuth 설정과 콜백 주소를 확인해 달라고 요청하세요.",
    missing_client_id: "개인 메일 연결 서버에 Google OAuth 클라이언트가 설정되지 않았습니다. 관리자에게 설정 확인을 요청하세요.",
    missing_client_secret: "개인 메일 연결 서버의 Google OAuth 보안 설정이 준비되지 않았습니다. 관리자에게 Secret 바인딩 확인을 요청하세요.",
    missing_encryption_key: "개인 메일 연결 서버의 자격증명 보호 설정이 준비되지 않았습니다. 관리자에게 Secret 바인딩 확인을 요청하세요.",
    missing_redirect_uri: "개인 메일 연결 서버의 OAuth 콜백 주소가 설정되지 않았습니다. 관리자에게 콜백 설정 확인을 요청하세요.",
    callback_mismatch: "Google OAuth 콜백 주소가 현재 스테이징 주소와 일치하지 않습니다. 관리자에게 승인된 콜백 주소를 확인해 달라고 요청하세요.",
    disabled_in_staging: "스테이징에서는 개인 메일 연결이 비활성화되어 있습니다. 관리자에게 스테이징 연결 게이트를 확인해 달라고 요청하세요.",
    tenant_mismatch: "현재 로그인 계정의 조직과 메일 연결 대상이 일치하지 않습니다. 본인 계정으로 다시 시도해 주세요.",
    account_not_found: "현재 로그인 계정에 연결할 메일 계정 레코드가 없습니다. 관리자에게 계정 매핑을 요청하세요.",
  };
  return labels[code ?? ""] ?? "메일 계정 연결을 시작하지 못했습니다. 관리자 화면에서 서버 설정과 계정 매핑을 확인해 주세요.";
}
