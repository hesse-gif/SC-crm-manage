"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Close, Plus } from "@/components/icons";
import { inviteMember, listMailAccounts, ROLES, setMemberMailAccountAccess, setMemberRole } from "@/lib/data"
import type { MailAccountPublic, Role, Member } from "@/lib/data"
import { requestDataRefresh, useLive, useLiveMembers } from "@/lib/live"

const ROLE_TABS: { key: "all" | Role; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "super_admin", label: "Super Admin" },
  { key: "admin", label: "Admin" },
  { key: "manager", label: "Manager" },
  { key: "viewer", label: "Viewer" },
  { key: "guest", label: "Guest" },
];

const STATUS_TABS: { key: "all" | "active" | "pending"; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "active", label: "활성" },
  { key: "pending", label: "대기" },
];

function normalizeMailAccountIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))];
}

function memberUid(member: Member): string | undefined {
  const uid = (member as { uid?: unknown }).uid;
  return typeof uid === "string" && uid.trim() ? uid.trim() : undefined;
}

function isLoginMemberDocument(member: Member): boolean {
  const uid = memberUid(member);
  return Boolean(uid && member.id === uid);
}

const PUBLIC_SCP_MAILBOX = "scp@supercent.io";

export default function MembersPage() {
  const { data, role } = useLive();
  const members = useLiveMembers<Member>([]);
  const totalMembers = data?.counts?.members ?? 0;
  const isMembersTruncated = totalMembers > members.length && members.length > 0;
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | Role>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "pending">("all");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [roleDraft, setRoleDraft] = useState<Record<string, Role>>({});
  const [mailAccessDraft, setMailAccessDraft] = useState<Record<string, string[]>>({});
  const [mailAccounts, setMailAccounts] = useState<MailAccountPublic[]>([]);
  const [mailAccountsPending, setMailAccountsPending] = useState(true);
  const [mailAccountsError, setMailAccountsError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [actionError, setActionError] = useState("");
  const canManageMailboxAccess = role === "super_admin";

  const pendingMembers = members.filter((m) => m.status === "pending");
  const active = members.filter((m) => m.status === "active");
  const mailAccountById = useMemo(
    () => new Map(mailAccounts.map((account) => [account.accountId, account])),
    [mailAccounts],
  );
  const duplicateEmailCountByEmail = useMemo(() => {
    const counts = new Map<string, number>();
    for (const member of members) {
      const email = member.email.trim().toLowerCase();
      if (!email) continue;
      counts.set(email, (counts.get(email) ?? 0) + 1);
    }
    return counts;
  }, [members]);

  useEffect(() => {
    if (!canManageMailboxAccess) {
      setMailAccounts([]);
      setMailAccountsPending(false);
      setMailAccountsError("");
      return;
    }
    let cancelled = false;
    setMailAccountsPending(true);
    listMailAccounts({})
      .then((response) => {
        if (cancelled) return;
        setMailAccounts(response.accounts);
        setMailAccountsError("");
      })
      .catch((caught) => {
        if (cancelled) return;
        setMailAccountsError(caught instanceof Error ? caught.message : "메일 계정을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!cancelled) setMailAccountsPending(false);
      });
    return () => { cancelled = true; };
  }, [canManageMailboxAccess]);

  const filtered = members.filter((m) => {
    const q = query.toLowerCase();
    const matchQuery =
      !q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q);
    const matchRole = roleFilter === "all" || m.role === roleFilter;
    const matchStatus = statusFilter === "all" || m.status === statusFilter;
    return matchQuery && matchRole && matchStatus;
  });

  async function changeMember(member: Member, nextRole: Role, nextStatus = member.status) {
    const actionId = `${member.id}:${nextRole}:${nextStatus}`;
    setBusyId(actionId);
    setActionError("");
    try {
      await setMemberRole({
        memberId: member.id,
        uid: memberUid(member),
        role: nextRole,
        team: member.team === "—" ? "AIX" : member.team,
        status: nextStatus,
        gameId: "flu-admin",
      });
      requestDataRefresh();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "멤버 권한을 저장하지 못했습니다.");
    } finally {
      setBusyId("");
    }
  }

  function memberMailAccessIds(member: Member): string[] {
    const ids = mailAccessDraft[member.id] ?? normalizeMailAccountIds(member.mailAccountIds);
    return member.email.trim().toLowerCase() === PUBLIC_SCP_MAILBOX
      ? ids.filter((id) => id === "scp")
      : ids;
  }

  function toggleMemberMailAccess(member: Member, accountId: string) {
    const current = memberMailAccessIds(member);
    const next = current.includes(accountId)
      ? current.filter((id) => id !== accountId)
      : [...current, accountId];
    setMailAccessDraft((prev) => ({ ...prev, [member.id]: next }));
  }

  async function saveMemberMailAccess(member: Member) {
    const uid = memberUid(member);
    if (!uid || !isLoginMemberDocument(member)) {
      setActionError("로그인 회원 행에서만 메일함 접근 권한을 저장할 수 있습니다.");
      return;
    }
    const nextIds = memberMailAccessIds(member);
    setBusyId(`${member.id}:mail-access`);
    setActionError("");
    try {
      const response = await setMemberMailAccountAccess({
        uid,
        memberId: member.id,
        mailAccountIds: nextIds,
      });
      setMailAccessDraft((prev) => ({ ...prev, [member.id]: response.mailAccountIds }));
      requestDataRefresh();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "메일함 접근 권한을 저장하지 못했습니다.");
    } finally {
      setBusyId("");
    }
  }

  return (
    <div className="mx-auto max-w-content px-6 py-7">
      <PageHeader
        title="멤버·권한"
        desc="RBAC 5단계 — 신규 가입자는 Guest, Super Admin 승인 필요"
        action={
          <Button onClick={() => setInviteOpen(true)}>
            <Plus className="h-[18px] w-[18px]" />
            멤버 초대
          </Button>
        }
      />

      {/* Pending banner */}
      {pendingMembers.length > 0 && (
        <div className="mb-5 flex items-center gap-3 rounded-lg border border-warn/40 bg-warn-soft px-4 py-3">
          <span className="flex-1 text-sm font-medium text-warn">
            수동 승인 대기 중인 사용자가 있습니다
          </span>
          <Badge tone="warn">{pendingMembers.length}명 대기</Badge>
        </div>
      )}

      {actionError ? (
        <div className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs font-semibold text-danger">
          {actionError}
        </div>
      ) : null}

      {/* Filter bar */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="text"
          placeholder="이메일 / 이름 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-9 w-full rounded-md border border-line bg-paper px-3 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent sm:w-56"
        />
        {/* Role tabs */}
        <div className="flex flex-wrap gap-1">
          {ROLE_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setRoleFilter(t.key)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                roleFilter === t.key
                  ? "bg-accent text-white"
                  : "bg-fill text-ink-2 hover:bg-accent/10"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {/* Status tabs */}
        <div className="flex gap-1">
          {STATUS_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setStatusFilter(t.key)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                statusFilter === t.key
                  ? "bg-accent text-white"
                  : "bg-fill text-ink-2 hover:bg-accent/10"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Truncation indicator */}
      {isMembersTruncated ? (
        <div
          data-testid="truncation-indicator"
          className="mb-4 flex items-center justify-between rounded-lg border border-warn/40 bg-warn-soft px-4 py-2.5 text-sm text-warn"
        >
          <span>전체 {totalMembers.toLocaleString()}명 중 {members.length}명 표시</span>
          <span className="text-xs font-semibold">더보기 준비 중</span>
        </div>
      ) : null}

      {/* Table */}
      <Card>
        <CardHeader
          title="멤버 목록"
          desc={canManageMailboxAccess
            ? `${filtered.length}명 표시 중 · 추가 메일함 접근은 명시적으로만 부여`
            : `${filtered.length}명 표시 중`}
        />
        {canManageMailboxAccess ? (
          <div className="border-b border-line bg-fill px-5 py-3 text-xs leading-5 text-ink-3" data-testid="member-mail-access-help">
            계정·라우팅은 연동 설정에서 관리하고, 이 표에서는 멤버별 추가 메일함 열람·발신 권한만 관리합니다. 공개 SCP 메일함은 `scp@supercent.io` 멤버에 `scp`를 명시적으로 부여한 경우에만 사용할 수 있습니다.
            {mailAccountsError ? <span className="ml-1 text-danger">{mailAccountsError}</span> : null}
          </div>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-sm">
            <thead>
              <tr className="border-b border-line bg-fill text-left text-xs font-semibold text-ink-3">
                <th className="px-5 py-2.5">멤버</th>
                <th className="px-4 py-2.5">역할</th>
                <th className="px-4 py-2.5">팀</th>
                <th className="px-4 py-2.5">담당</th>
                <th className="px-4 py-2.5">추가 메일함 접근</th>
                <th className="px-4 py-2.5">상태</th>
                <th className="px-5 py-2.5 text-right">액션</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => {
                const roleMeta = ROLES[m.role];
                const uid = memberUid(m);
                const duplicateEmailCount = duplicateEmailCountByEmail.get(m.email.trim().toLowerCase()) ?? 0;
                return (
                  <tr
                    key={m.id}
                    className="border-b border-line last:border-0 hover:bg-fill/50"
                  >
                    {/* 멤버 */}
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <Avatar label={m.avatar} size={32} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 font-semibold text-ink">
                            {m.status === "pending" ? <span className="h-2 w-2 rounded-full bg-danger" aria-label="승인 대기" /> : null}
                            {m.name}
                            {duplicateEmailCount > 1 ? <Badge tone="warn">동일 이메일 {duplicateEmailCount}개</Badge> : null}
                          </div>
                          <div className="truncate text-[11px] text-ink-3">{m.email}</div>
                          <div className="truncate text-[10px] text-ink-4" title={uid ? `UID ${uid}` : `문서 ${m.id}`}>
                            {uid ? `UID ${uid}` : `문서 ${m.id} · UID 미확인`}
                          </div>
                        </div>
                      </div>
                    </td>
                    {/* 역할 */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Badge tone={roleMeta.tone}>{roleMeta.label}</Badge>
                        <select
                          value={roleDraft[m.id] ?? m.role}
                          onChange={(event) => setRoleDraft((prev) => ({ ...prev, [m.id]: event.target.value as Role }))}
                          className="h-8 rounded-md border border-line bg-paper px-2 text-xs font-semibold text-ink"
                          aria-label={`${m.name} 역할`}
                        >
                          {Object.entries(ROLES).map(([key, meta]) => (
                            <option key={key} value={key}>{meta.label}</option>
                          ))}
                        </select>
                      </div>
                    </td>
                    {/* 팀 */}
                    <td className="px-4 py-3 text-ink-2">{m.team}</td>
                    {/* 담당 */}
                    <td className="px-4 py-3 text-ink-2">{m.assigned}명</td>
                    {/* 추가 메일함 접근 */}
                    <td className="px-4 py-3">
                      <MemberMailAccessEditor
                        member={m}
                        accounts={mailAccounts}
                        accountById={mailAccountById}
                        canManage={canManageMailboxAccess}
                        selectedIds={memberMailAccessIds(m)}
                        pending={mailAccountsPending || busyId === `${m.id}:mail-access`}
                        error={mailAccountsError}
                        duplicateEmailCount={duplicateEmailCount}
                        onToggle={(accountId) => toggleMemberMailAccess(m, accountId)}
                        onSave={() => saveMemberMailAccess(m)}
                      />
                    </td>
                    {/* 상태 */}
                    <td className="px-4 py-3">
                      <Badge tone={m.status === "active" ? "ok" : "warn"}>
                        {m.status === "active" ? "활성" : "대기"}
                      </Badge>
                    </td>
                    {/* 액션 */}
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {m.status === "active" ? (
                          <>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busyId.startsWith(`${m.id}:`)}
                              onClick={() => changeMember(m, roleDraft[m.id] ?? m.role, "active")}
                            >
                              저장
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busyId.startsWith(`${m.id}:`)}
                              onClick={() => changeMember(m, roleDraft[m.id] ?? m.role, "pending")}
                            >
                              비활성화
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              disabled={busyId.startsWith(`${m.id}:`)}
                              onClick={() => changeMember(m, roleDraft[m.id] ?? (m.role === "guest" ? "viewer" : m.role), "active")}
                            >
                              승인·역할 지정
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busyId.startsWith(`${m.id}:`)}
                              onClick={() => changeMember(m, "guest", "pending")}
                            >
                              보류
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="py-10 text-center text-sm text-ink-4"
                  >
                    검색 결과가 없습니다
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Footer summary */}
        <div className="border-t border-line px-5 py-3 text-xs text-ink-3">
          전체 {members.length}명 · 활성 {active.length}명 · 대기{" "}
          {pendingMembers.length}명
        </div>
      </Card>
      {inviteOpen ? <InviteMemberModal onClose={() => setInviteOpen(false)} /> : null}
    </div>
  );
}

function MemberMailAccessEditor({
  member,
  accounts,
  accountById,
  canManage,
  selectedIds,
  pending,
  error,
  onToggle,
  duplicateEmailCount,
  onSave,
}: {
  member: Member;
  accounts: MailAccountPublic[];
  accountById: Map<string, MailAccountPublic>;
  canManage: boolean;
  selectedIds: string[];
  pending: boolean;
  error: string;
  duplicateEmailCount: number;
  onToggle: (accountId: string) => void;
  onSave: () => void;
}) {
  if (!canManage) return <span className="text-xs text-ink-4">Super Admin 전용</span>;
  if (member.status !== "active" || member.role === "guest") {
    return <span className="text-xs text-ink-4">활성 non-guest 전용</span>;
  }
  const uid = memberUid(member);
  if (!uid) {
    return <span className="text-xs text-ink-4">UID 확인 필요</span>;
  }
  if (!isLoginMemberDocument(member)) {
    return (
      <span
        className="text-xs text-ink-4"
        data-testid="member-mail-access-alias"
        data-member-id={member.id}
        data-member-uid={uid}
      >
        초대 기록 · 로그인 회원에서 설정
      </span>
    );
  }
  const visibleAccounts = member.email.trim().toLowerCase() === PUBLIC_SCP_MAILBOX
    ? accounts.filter((account) => account.accountId === "scp")
    : accounts;
  const currentIds = member.email.trim().toLowerCase() === PUBLIC_SCP_MAILBOX
    ? normalizeMailAccountIds(member.mailAccountIds).filter((id) => id === "scp")
    : normalizeMailAccountIds(member.mailAccountIds);
  const dirty = selectedIds.length !== currentIds.length || selectedIds.some((id) => !currentIds.includes(id));
  const selectedLabels = selectedIds.map((id) => accountById.get(id)?.label ?? id);

  if (error) {
    return <span className="text-xs font-semibold text-danger">{error}</span>;
  }
  if (pending && accounts.length === 0) {
    return <span className="text-xs text-ink-3">메일 계정 확인 중</span>;
  }
  if (visibleAccounts.length === 0) {
    return <span className="text-xs text-ink-3">등록된 메일 계정 없음</span>;
  }

  return (
    <div className="min-w-[260px] space-y-2" data-testid="member-mail-access" data-member-id={member.id} data-member-uid={uid}>
      <div className="flex flex-wrap gap-1.5">
        {visibleAccounts.map((account) => {
          const checked = selectedIds.includes(account.accountId);
          return (
            <label
              key={account.accountId}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] font-semibold ${
                checked ? "border-accent bg-accent/10 text-accent" : "border-line bg-fill text-ink-3"
              }`}
              title={`${account.mailbox} · ${account.ownerEmail}`}
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-accent"
                checked={checked}
                disabled={pending}
                onChange={() => onToggle(account.accountId)}
                aria-label={`${member.name} ${account.label} 접근`}
              />
              {account.label}
            </label>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[11px] text-ink-3" title={selectedLabels.join(", ")}>
          {selectedLabels.length > 0 ? selectedLabels.join(", ") : "추가 접근 없음"}
        </span>
        {duplicateEmailCount > 1 ? <span className="text-[10px] font-semibold text-warn">로그인 회원 기준 저장</span> : null}
        <Button size="sm" variant={dirty ? "primary" : "secondary"} disabled={pending || !dirty} onClick={onSave}>
          {pending ? "저장 중" : "접근 저장"}
        </Button>
      </div>
    </div>
  );
}

function InviteMemberModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [team, setTeam] = useState("AIX");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setSaving(true);
    setError("");
    try {
      await inviteMember({
        email,
        name,
        role,
        team,
        gameId: "flu-admin",
      });
      requestDataRefresh();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "초대하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-paper shadow-pop">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <div className="text-base font-bold text-ink">멤버 초대</div>
            <div className="text-xs text-ink-3">초대된 사용자는 승인 전까지 대기 상태입니다.</div>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-1.5 text-ink-3 hover:bg-fill" aria-label="닫기">
            <Close className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 px-5 py-5">
          <label className="block text-xs font-semibold text-ink-3">
            이메일
            <input value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1.5 h-10 w-full rounded-md border border-line bg-paper px-3 text-sm text-ink" placeholder="name@supercent.io" />
          </label>
          <label className="block text-xs font-semibold text-ink-3">
            이름
            <input value={name} onChange={(event) => setName(event.target.value)} className="mt-1.5 h-10 w-full rounded-md border border-line bg-paper px-3 text-sm text-ink" placeholder="이름" />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-semibold text-ink-3">
              역할
              <select value={role} onChange={(event) => setRole(event.target.value as Role)} className="mt-1.5 h-10 w-full rounded-md border border-line bg-paper px-3 text-sm text-ink">
                {Object.entries(ROLES).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
              </select>
            </label>
            <label className="block text-xs font-semibold text-ink-3">
              팀
              <input value={team} onChange={(event) => setTeam(event.target.value)} className="mt-1.5 h-10 w-full rounded-md border border-line bg-paper px-3 text-sm text-ink" />
            </label>
          </div>
          {error ? <div className="rounded-md bg-danger-soft px-3 py-2 text-xs font-semibold text-danger">{error}</div> : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
          <Button variant="ghost" onClick={onClose}>취소</Button>
          <Button onClick={save} disabled={saving || !email.includes("@")}>
            <Plus className="h-4 w-4" />
            {saving ? "초대 중" : "초대"}
          </Button>
        </div>
      </div>
    </div>
  );
}
