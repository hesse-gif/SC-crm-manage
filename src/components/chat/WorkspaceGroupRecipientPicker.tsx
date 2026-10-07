"use client";

import { useState } from "react";

import { searchPeoplyDirectory, type PeoplyWorkspaceGroup, type SearchPeoplyDirectoryEnvelope } from "@/lib/data";
import { Button } from "@/components/ui/Button";

function isWorkspaceGroup(item: unknown): item is PeoplyWorkspaceGroup {
  if (!item || typeof item !== "object") return false;
  const value = item as Partial<PeoplyWorkspaceGroup>;
  return typeof value.email === "string"
    && typeof value.name === "string"
    && typeof value.directMemberCount === "number";
}

function groupSearchError(response: SearchPeoplyDirectoryEnvelope): string {
  if (response.peoplyError?.kind === "forbidden") return "그룹 검색 권한이 없습니다.";
  if (response.peoplyError?.kind === "missing_key") return "사내 그룹 검색이 아직 설정되지 않았습니다.";
  if (response.peoplyError?.kind === "rate_limited") return "그룹 검색 요청이 잠시 제한되었습니다. 잠시 후 다시 시도하세요.";
  return "그룹 검색 결과를 불러오지 못했습니다.";
}

interface WorkspaceGroupRecipientPickerProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

/**
 * Explicit Peoply group search for a mail recipient. Search results are the server's approved
 * Workspace group projection; selecting one only fills the recipient address and never grants
 * sender permission or expands the group's membership.
 */
export function WorkspaceGroupRecipientPicker({
  value,
  onChange,
  disabled = false,
}: WorkspaceGroupRecipientPickerProps) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<SearchPeoplyDirectoryEnvelope | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<PeoplyWorkspaceGroup | null>(null);

  async function runSearch() {
    const trimmed = query.trim();
    if (!trimmed) {
      setResult(null);
      return;
    }
    setPending(true);
    try {
      const response = await searchPeoplyDirectory({ kind: "workspace-groups", q: trimmed });
      setResult(response);
    } catch {
      setResult(null);
    } finally {
      setPending(false);
    }
  }

  const groups = result?.ok
    ? (result.snapshot?.items ?? []).filter(isWorkspaceGroup)
    : [];

  return (
    <div className="space-y-2" data-testid="workspace-group-recipient-picker">
      <label className="block text-[11px] font-semibold text-ink-3" htmlFor="chat-mail-recipient">
        받는 사람
      </label>
      <input
        id="chat-mail-recipient"
        type="email"
        value={value}
        disabled={disabled}
        onChange={(event) => {
          setSelectedGroup(null);
          onChange(event.target.value);
        }}
        placeholder="이메일 주소 또는 Workspace 그룹 주소"
        className="h-9 w-full rounded-md border border-line bg-paper px-3 text-xs text-ink outline-none placeholder:text-ink-4 focus:border-ink-4 disabled:cursor-not-allowed disabled:bg-fill"
        aria-describedby="chat-mail-recipient-help"
      />
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={query}
          disabled={disabled || pending}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void runSearch(); }}
          placeholder="그룹 이름 또는 주소 검색"
          className="h-8 min-w-0 flex-1 rounded-md border border-line bg-paper px-3 text-xs text-ink outline-none placeholder:text-ink-4 focus:border-ink-4 disabled:cursor-not-allowed disabled:bg-fill"
          aria-label="Workspace 그룹 검색"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || pending || !query.trim()}
          onClick={() => void runSearch()}
          aria-label="Workspace 그룹 검색 실행"
        >
          {pending ? "검색 중" : "그룹 검색"}
        </Button>
      </div>
      <p id="chat-mail-recipient-help" className="text-[10.5px] leading-4 text-ink-4">
        검색 결과에서 실제 Workspace 그룹 주소를 선택하면 받는 사람에 입력됩니다.
      </p>
      {result && !result.ok && (
        <p className="text-[11px] leading-4 text-danger" role="alert">{groupSearchError(result)}</p>
      )}
      {groups.length > 0 && (
        <div className="max-h-44 overflow-y-auto rounded-md border border-line bg-paper" role="listbox" aria-label="Workspace 그룹 검색 결과">
          {groups.map((group) => (
            <button
              key={group.email}
              type="button"
              role="option"
              aria-selected={selectedGroup?.email === group.email}
              className="flex w-full items-start gap-2 border-b border-line px-3 py-2 text-left last:border-b-0 hover:bg-fill"
              onClick={() => {
                setSelectedGroup(group);
                onChange(group.email);
                setResult(null);
                setQuery("");
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-ink">{group.name}</span>
                <span className="block truncate text-[11px] text-ink-3">{group.email}</span>
              </span>
              <span className="shrink-0 text-[10px] text-ink-4">직접 멤버 {group.directMemberCount}명</span>
            </button>
          ))}
        </div>
      )}
      {result?.ok && groups.length === 0 && (
        <p className="text-[11px] leading-4 text-ink-3">검색 결과가 없습니다.</p>
      )}
      {selectedGroup && value === selectedGroup.email && (
        <p className="text-[11px] font-medium text-accent" role="status">
          그룹 수신자 선택됨 · {selectedGroup.name}
        </p>
      )}
    </div>
  );
}
