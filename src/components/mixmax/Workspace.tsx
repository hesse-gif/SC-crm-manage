"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { command, errorMessage, login, logout, useMixmaxRows, useMixmaxSession, value, type MixmaxMember, type MixmaxRow } from "@/lib/mixmax";
import styles from "./workspace.module.css";

type View = "feed" | "drafts" | "sequences" | "templates" | "contacts" | "outbox" | "cases" | "settings";
const navigation: { id: View; name: string; icon: string }[] = [
  { id: "feed", name: "Live feed", icon: "ϟ" }, { id: "drafts", name: "AI drafts", icon: "✧" }, { id: "sequences", name: "Sequences", icon: "▱" },
  { id: "templates", name: "Email templates", icon: "▤" }, { id: "contacts", name: "Contacts", icon: "♙" }, { id: "outbox", name: "Outbox", icon: "↗" }, { id: "cases", name: "Case library", icon: "◇" },
];
const collectionNames: Record<View, string> = { feed: "mixmax_threads", drafts: "mixmax_drafts", sequences: "mixmax_sequences", templates: "mixmax_templates", contacts: "mixmax_contacts", outbox: "mixmax_sends", cases: "mixmax_cases", settings: "mixmax_connections" };
const dateLabel = (date: string) => date && !date.startsWith("1970") ? new Date(date).toLocaleDateString("ko-KR", { month: "short", day: "numeric" }) : "";
function Brand() { return <div className={styles.brand}><span>M</span> Mixmax</div>; }
function connectedForThread(thread: MixmaxRow | null | undefined, accounts: MixmaxRow[]) {
  if (!thread) return accounts;
  return accounts.filter(account => value(account, "status") === "connected" && (thread.source === "gmail" ? account.id === thread.connectionId : value(thread, "mailbox") && value(account, "email").toLowerCase() === value(thread, "mailbox").toLowerCase()));
}
function isFluThread(thread: MixmaxRow | null | undefined) {
  return thread?.source === "flu" || thread?.sourceSystem === "flu";
}
function needsMailboxAssignment(thread: MixmaxRow | null | undefined) {
  return Boolean(thread && isFluThread(thread) && !value(thread, "mailbox"));
}
function replyRecipient(thread: MixmaxRow | null | undefined, draft: MixmaxRow | null | undefined = null) {
  const explicit = value(draft, "to");
  if (explicit) return explicit;
  const mailbox = value(thread, "mailbox").toLowerCase();
  const participants = Array.isArray(thread?.participantEmails) ? thread.participantEmails.filter((email): email is string => typeof email === "string") : [];
  return participants.find(email => email.toLowerCase() !== mailbox) ?? "";
}
function replySubject(source: MixmaxRow | null | undefined) {
  const subject = value(source, "subject");
  if (!subject) return "";
  return subject.startsWith("Re:") ? subject : `Re: ${subject}`;
}

export function MixmaxWorkspace() {
  const session = useMixmaxSession();
  const [authError, setAuthError] = useState("");
  if (!session.member) return <div className={styles.login}><aside><Brand /><h1>Every conversation.<br />One workspace.</h1><p>메일과 연락처, 답변의 맥락을 한곳에서.<br />AI 초안을 검토하고 대화를 이어가세요.</p></aside><main><div><span className={styles.eyebrow}>YOUR COMMUNICATION WORKSPACE</span><h2>Mixmax에 오신 것을 환영합니다</h2><p>Google 계정으로 워크스페이스를 열어주세요.</p>{session.loading ? <p role="status">워크스페이스를 확인하는 중…</p> : <button className={styles.primary} onClick={() => void login().catch(e => setAuthError(errorMessage(e)))}>Google로 계속하기</button>}{(session.error || authError) && <p role="alert" className={styles.error}>{session.error || authError}</p>}{session.user && <button className={styles.linkButton} onClick={() => void logout()}>다른 계정으로 로그인</button>}<p className={styles.hint}>메일 계정은 로그인 후 별도로 연결할 수 있습니다.</p></div></main></div>;
  return <Workspace key={session.member.uid} member={session.member} />;
}
function Workspace({ member }: { member: MixmaxMember }) {
  const [view, setView] = useState<View>("feed");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<MixmaxRow | null>(null);
  const [count, setCount] = useState(200);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const [editing, setEditing] = useState<MixmaxRow | null | undefined>(undefined);
  const items = useMixmaxRows(member, collectionNames[view], { sort: view === "feed" ? "lastMessageAt" : view === "outbox" ? "createdAt" : undefined, count, owner: view === "outbox" || view === "settings" || view === "drafts" });
  const accounts = useMixmaxRows(member, "mixmax_connections", { owner: true, count: 30 });
  const templates = useMixmaxRows(member, "mixmax_templates", { count: 100, enabled: Boolean(selected || composing) });
  const cases = useMixmaxRows(member, "mixmax_cases", { count: 100, enabled: Boolean(selected || composing) });
  const draftThread = useMixmaxDocument(member, "mixmax_threads", view === "drafts" ? value(selected, "threadId") : "");
  const draftNeedsMailbox = Boolean(value(selected, "threadId")) && needsMailboxAssignment(draftThread.row);
  const rows = useMemo(() => items.rows.filter(row => {
    if (view === "feed" && (filter === "unread" ? !row.unread : filter === "starred" ? !row.starred : filter === "imported" ? row.source !== "flu" : filter === "archived" ? !row.archived : Boolean(row.archived))) return false;
    return !search || [row.subject, row.name, row.snippet, row.email, row.body, row.to, row.participantEmails].join(" ").toLowerCase().includes(search.toLowerCase());
  }), [items.rows, view, filter, search]);
  useEffect(() => { const status = new URLSearchParams(window.location.search).get("connection"); if (status) { setNotice(status === "connected" ? "Google 메일이 연결되었습니다. 메일을 가져오는 중입니다." : status === "cancelled" ? "메일 연결을 취소했습니다." : "메일 연결을 완료하지 못했습니다. 권한과 Google 연결 설정을 확인해 주세요."); window.history.replaceState(null, "", "/mail"); } }, []);
  async function run(task: () => Promise<unknown>, success = "") { setBusy(true); setNotice(""); try { await task(); if (success) setNotice(success); } catch (error) { setNotice(errorMessage(error)); } finally { setBusy(false); } }
  function navigate(next: View) { setView(next); setSelected(null); setComposing(false); setEditing(undefined); setSearch(""); setCount(200); }
  async function connect() { await run(async () => { const result = await command<{ url: string }>("mixmaxBeginGoogleOAuth"); const url = new URL(result.url); if (url.origin !== "https://accounts.google.com") throw new Error("잘못된 Google 연결 주소입니다."); window.location.assign(url.toString()); }); }
  const heading = navigation.find(item => item.id === view)?.name ?? "My settings";
  return <div className={styles.workspace}>
    <aside className={styles.sidebar}><Brand /><button className={styles.compose} onClick={() => { setSelected(null); setComposing(true); }}>↗ <span>Compose</span></button><nav aria-label="Main navigation">{navigation.map(item => <button key={item.id} className={view === item.id ? styles.activeNav : ""} onClick={() => navigate(item.id)}><span>{item.icon}</span>{item.name}</button>)}</nav><div className={styles.sidebarBottom}><span className={styles.eyebrow}>WORKSPACE</span><button className={view === "settings" ? styles.activeNav : ""} onClick={() => navigate("settings")}>⚙ My settings</button><div className={styles.profile}><span>{member.email.slice(0, 1).toUpperCase()}</span><div><strong>{member.email.split("@")[0]}</strong><small>{member.email}</small></div><button title="로그아웃" aria-label="로그아웃" onClick={() => void logout()}>↪</button></div></div></aside>
    <aside className={styles.secondary}><h1>{heading}</h1>{view === "feed" ? <><span className={styles.eyebrow}>MY FEED</span>{[["all", "All conversations"], ["unread", "Unread"], ["starred", "Starred"], ["imported", "From Flu"], ["archived", "Archived"]].map(([id, name]) => <button key={id} className={filter === id ? styles.activeFilter : ""} onClick={() => setFilter(id)}>{name}</button>)}<hr /></> : <p className={styles.hint}>{view === "cases" ? "상황별 답변 정책과 기준을 모아 AI 초안에 활용하세요." : view === "drafts" ? "보내기 전에 AI가 작성한 답변을 검토하세요." : view === "sequences" ? "후속 연락의 내용과 순서를 작성하는 초안 보관함입니다." : "팀의 대화를 한곳에서 관리하세요."}</p>}<span className={styles.eyebrow}>CONNECTED ACCOUNTS</span>{accounts.rows.length === 0 && <p className={styles.hint}>메일 계정을 연결하면 새 메일이 여기에 도착합니다.</p>}{accounts.rows.map(row => <div key={row.id} className={styles.accountMini}><i className={value(row, "status") === "connected" ? styles.online : styles.offline} /><span>{value(row, "email")}<small>{value(row, "syncStatus") === "syncing" ? "메일 가져오는 중" : value(row, "status") === "connected" ? "Connected" : "연결 확인 필요"}</small></span></div>)}<button className={styles.linkButton} onClick={() => void connect()} disabled={busy}>＋ Google 계정 연결</button></aside>
    <main className={styles.main}><header className={styles.topbar}><label className={styles.search}>⌕<input aria-label="현재 목록 검색" placeholder="Search this view" value={search} onChange={event => setSearch(event.target.value)} /></label><span className={styles.syncBadge}><i /> Mixmax workspace</span><button className={styles.outline} onClick={() => { if (selected) document.getElementById("mixmax-ai-instruction")?.focus(); else navigate("drafts"); }}>✧ Ask Mixmax</button></header>
      {(notice || items.error || accounts.error || draftThread.error) && <div role="status" className={styles.notice}>{notice || items.error || accounts.error || draftThread.error}<button aria-label="알림 닫기" onClick={() => setNotice("")}>×</button></div>}
      <div className={styles.viewHeader}><div><h2>{view === "feed" ? (filter === "all" ? "All conversations" : filter.charAt(0).toUpperCase() + filter.slice(1)) : heading}</h2><p>{items.loading ? "불러오는 중…" : `${rows.length.toLocaleString()} ${view === "feed" ? "conversations" : "items"}`}{count === items.rows.length ? " · 최근 항목" : ""}</p></div>{["templates", "cases", "contacts", "sequences"].includes(view) && <button className={styles.primary} onClick={() => setEditing(null)}>＋ New {view === "templates" ? "template" : view === "contacts" ? "contact" : view === "cases" ? "case" : "sequence"}</button>}{view === "settings" && <button className={styles.primary} onClick={() => void connect()} disabled={busy}>Connect Google account</button>}</div>
      {view === "settings" ? <section className={styles.settings}><h3>메일 계정</h3><p>Google 계정을 여러 개 연결할 수 있습니다. 메일 내용과 초안은 이 Mixmax 워크스페이스에 저장됩니다.</p>{accounts.rows.map(account => <article key={account.id}><div><strong>{value(account, "email")}</strong><p>{value(account, "status")} · {value(account, "lastSyncAt") ? `최근 수신 ${dateLabel(value(account, "lastSyncAt"))}` : "첫 메일 동기화 대기"}</p>{value(account, "syncError") && <p className={styles.error}>{value(account, "syncError")}</p>}</div><button className={styles.outline} disabled={busy || value(account, "status") !== "connected"} onClick={() => void run(() => command("mixmaxSyncMailbox", { connectionId: account.id }), "메일 변경분을 확인합니다.")}>Refresh</button><button className={styles.linkButton} disabled={busy || value(account, "status") === "disconnected"} onClick={() => void run(() => command("mixmaxDisconnectGoogle", { connectionId: account.id }), "계정 연결을 해제했습니다.")}>Disconnect</button></article>)}</section> : <div className={styles.content}>
        <section className={`${styles.list} ${selected ? styles.listNarrow : ""}`} aria-label={heading}>
          <div className={styles.tableHeading}><span>{view === "feed" ? "CONVERSATION" : view === "contacts" ? "CONTACT" : "NAME"}</span><span>{view === "outbox" ? "STATUS" : "UPDATED"}</span></div>
          {items.loading ? <div className={styles.empty} role="status">불러오는 중…</div> : rows.length === 0 ? <div className={styles.empty}><span>✉</span><h3>{search ? "검색 결과가 없습니다" : view === "feed" ? "대화를 기다리고 있습니다" : "아직 등록된 항목이 없습니다"}</h3><p>{view === "feed" ? "기존 대화를 가져오거나 Google 메일을 연결해 시작하세요." : "새 항목을 만들면 여기에 표시됩니다."}</p></div> : rows.map(row => <button key={row.id} data-testid={`row-${row.id}`} className={`${styles.row} ${selected?.id === row.id ? styles.selectedRow : ""}`} onClick={() => { if (view === "feed" || view === "drafts" || view === "outbox") { setSelected(row); setComposing(false); } else setEditing(row); }}><span className={styles.avatar}>{(value(row, "name") || value(row, "subject") || value(row, "email") || "M").slice(0, 1).toUpperCase()}</span><div className={styles.rowBody}><div><strong>{(["feed", "drafts", "outbox"].includes(view) ? value(row, "subject") || value(row, "name") : value(row, "name") || value(row, "subject")) || value(row, "email") || "Untitled"}</strong>{row.unread === true && <i className={styles.unreadDot} />}{row.source === "flu" && <small className={styles.sourceTag}>Flu</small>}{view === "drafts" && <small className={styles.sourceTag}>검토 대기</small>}</div><p>{value(row, "snippet") || value(row, "email") || value(row, "description") || value(row, "body") || value(row, "to")}</p></div><small>{view === "outbox" ? value(row, "status") : dateLabel(value(row, "lastMessageAt") || value(row, "updatedAt") || value(row, "createdAt"))}</small></button>)}
          {items.rows.length === count && <button className={styles.loadMore} onClick={() => setCount(count + 200)}>Load more</button>}
        </section>
        {selected && view === "feed" && <ThreadPanel key={selected.id} member={member} thread={items.rows.find(row => row.id === selected.id) ?? selected} accounts={accounts.rows} templates={templates.rows} cases={cases.rows} close={() => setSelected(null)} notify={setNotice} />}
        {selected && (view === "drafts" || view === "outbox") && <section className={styles.detail}><button className={styles.close} onClick={() => setSelected(null)}>×</button><h2>{value(selected, "subject") || "Draft"}</h2><p className={styles.hint}>{value(selected, "status")}</p><pre className={styles.messageText}>{value(selected, "body")}</pre>{view === "drafts" && <><ImportedMailboxAssignment thread={draftThread.row} accounts={accounts.rows} notify={setNotice} /><button className={styles.primary} onClick={() => setComposing(true)} disabled={(Boolean(value(selected, "threadId")) && draftThread.loading) || draftNeedsMailbox}>검토하고 메일 작성</button></>}</section>}
      </div>}
    </main>
    {composing && <div className={styles.modalBackdrop}><section className={styles.composeModal} role="dialog" aria-label="Compose email"><header><h2>{value(selected, "threadId") ? "Reply" : "New message"}</h2><button aria-label="작성창 닫기" onClick={() => setComposing(false)}>×</button></header><Composer key={selected?.id ?? "new"} member={member} threadId={value(selected, "threadId")} accounts={value(selected, "threadId") ? connectedForThread(draftThread.row, accounts.rows) : accounts.rows} templates={templates.rows} cases={cases.rows} initialBody={value(selected, "body")} initialSubject={value(selected, "threadId") ? replySubject(draftThread.row ?? selected) : value(selected, "subject")} initialTo={value(selected, "threadId") ? replyRecipient(draftThread.row, selected) : value(selected, "to")} notify={setNotice} /></section></div>}
    {editing !== undefined && <ItemEditor view={view} item={editing} close={() => setEditing(undefined)} saved={() => { setEditing(undefined); setNotice("저장했습니다."); }} />}
  </div>;
}
function ImportedMailboxAssignment({ thread, accounts, notify }: { thread: MixmaxRow | null | undefined; accounts: MixmaxRow[]; notify: (text: string) => void }) {
  const connected = accounts.filter(account => value(account, "status") === "connected");
  const [connectionId, setConnectionId] = useState("");
  const [busy, setBusy] = useState(false);
  if (!needsMailboxAssignment(thread)) return null;
  const selected = connected.some(account => account.id === connectionId) ? connectionId : connected[0]?.id ?? "";
  async function assign() {
    if (!thread || !selected) return;
    setBusy(true);
    try {
      await command("mixmaxAssignThreadMailbox", { threadId: thread.id, connectionId: selected });
      notify("이 과거 대화의 발신 계정을 지정했습니다.");
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return <div className={styles.aiRow}><span className={styles.hint}>저장된 과거 발신 계정이 없습니다. 답장 전에 연결된 Google 계정 중 하나를 이 대화의 발신 계정으로 지정하세요. 메일은 발송되지 않습니다.</span>{connected.length > 0 && <select aria-label="과거 대화 발신 계정" value={selected} onChange={event => setConnectionId(event.target.value)}>{connected.map(account => <option key={account.id} value={account.id}>{value(account, "email")}</option>)}</select>}<button type="button" disabled={busy || !selected} onClick={() => void assign()}>발신 계정 지정</button></div>;
}
function useMixmaxDocument(member: MixmaxMember, name: string, id: string) {
  const [result, setResult] = useState<{ row: MixmaxRow | null; loading: boolean; error: string }>({ row: null, loading: false, error: "" });
  useEffect(() => {
    setResult({ row: null, loading: Boolean(id), error: "" });
    if (!id) return;
    return onSnapshot(doc(db, name, id), snapshot => {
      setResult({ row: snapshot.exists() ? { ...snapshot.data(), id: snapshot.id } : null, loading: false, error: snapshot.exists() ? "" : "대화 원문을 찾을 수 없습니다." });
    }, error => setResult({ row: null, loading: false, error: errorMessage(error) }));
  }, [member.workspaceId, name, id]);
  return result;
}
function ThreadPanel({ member, thread, accounts, templates, cases, close, notify }: { member: MixmaxMember; thread: MixmaxRow; accounts: MixmaxRow[]; templates: MixmaxRow[]; cases: MixmaxRow[]; close: () => void; notify: (text: string) => void }) {
  const messages = useMixmaxRows(member, "mixmax_messages", { threadId: thread.id, sort: "sentAt", count: 100 });
  const matching = connectedForThread(thread, accounts);
  const participants = Array.isArray(thread.participantEmails) ? thread.participantEmails.filter((email): email is string => typeof email === "string") : [];
  const recipient = replyRecipient(thread);
  function update(patch: Record<string, boolean>) { void command("mixmaxUpdateThread", { threadId: thread.id, ...patch }).catch(error => notify(errorMessage(error))); }
  return <section className={styles.detail}><div className={styles.detailActions}><button className={styles.linkButton} onClick={() => update({ starred: !thread.starred })}>{thread.starred ? "★ Starred" : "☆ Star"}</button><button className={styles.linkButton} onClick={() => update({ unread: !thread.unread })}>{thread.unread ? "Mark read" : "Mark unread"}</button><button className={styles.linkButton} onClick={() => update({ archived: !thread.archived })}>{thread.archived ? "Unarchive" : "Archive"}</button><button className={styles.close} aria-label="대화 닫기" onClick={close}>×</button></div><h2>{value(thread, "subject")}</h2><p className={styles.hint}>{participants.join(" · ")}</p>{messages.error && <p role="alert">{messages.error}</p>}<div className={styles.messages}>{messages.rows.slice().reverse().map(message => <article key={message.id} className={styles.message}><header><strong>{value(message, "from") || "Imported message"}</strong><small>{dateLabel(value(message, "sentAt"))}</small></header><pre className={styles.messageText}>{value(message, "text")}</pre></article>)}{messages.loading && <p>메시지를 불러오는 중…</p>}</div><ImportedMailboxAssignment thread={thread} accounts={accounts} notify={notify} /><Composer member={member} threadId={thread.id} accounts={matching} templates={templates} cases={cases} initialBody={value(thread, "aiDraft")} initialTo={recipient} initialSubject={replySubject(thread)} notify={notify} /></section>;
}
function Composer({ member, threadId = "", accounts, templates, cases, initialBody = "", initialTo = "", initialSubject = "", notify }: { member: MixmaxMember; threadId?: string; accounts: MixmaxRow[]; templates: MixmaxRow[]; cases: MixmaxRow[]; initialBody?: string; initialTo?: string; initialSubject?: string; notify: (text: string) => void }) {
  const storageKey = `mixmax.draft:${member.uid}:${threadId || "new"}`;
  const [body, setBody] = useState(initialBody); const [subject, setSubject] = useState(initialSubject); const [to, setTo] = useState(initialTo); const [connectionId, setConnection] = useState("");
  const [instruction, setInstruction] = useState(""); const [templateId, setTemplate] = useState(""); const [caseId, setCase] = useState(""); const [busy, setBusy] = useState(false); const [requestId, setRequestId] = useState(""); const [sent, setSent] = useState(false);
  const connected = accounts.filter(row => value(row, "status") === "connected");
  const accountId = connected.some(row => row.id === connectionId) ? connectionId : connected[0]?.id ?? "";
  useEffect(() => { try { const stored = sessionStorage.getItem(storageKey); if (stored) setBody(stored); } catch {} }, [storageKey]);
  function changeBody(text: string) { setBody(text); setRequestId(""); setSent(false); try { sessionStorage.setItem(storageKey, text); } catch {} }
  async function act(name: string, payload: Record<string, unknown>, message: string) { setBusy(true); try { const response = await command(name, payload); notify(message); return response; } catch (error) { notify(errorMessage(error)); } finally { setBusy(false); } }
  async function send(event: FormEvent) { event.preventDefault(); const id = requestId || crypto.randomUUID(); setRequestId(id); const result = await act("mixmaxSendMail", { requestId: id, connectionId: accountId, threadId, to, subject, body }, "메일을 발송했습니다."); if (result) { setSent(true); try { sessionStorage.removeItem(storageKey); } catch {} } }
  return <form className={styles.composerBox} onSubmit={event => void send(event)}><h3>{threadId ? "Reply" : "Compose"}</h3><label>From<select aria-label="발신 계정" value={accountId} onChange={event => { setConnection(event.target.value); setRequestId(""); }}>{connected.length === 0 && <option value="">Google 메일 연결 필요</option>}{connected.map(account => <option key={account.id} value={account.id}>{value(account, "email")}</option>)}</select></label><label>To<input required type="email" aria-label="받는 사람" value={to} onChange={event => { setTo(event.target.value); setRequestId(""); }} /></label><label>Subject<input required aria-label="메일 제목" value={subject} onChange={event => { setSubject(event.target.value); setRequestId(""); }} /></label><div className={styles.selectRow}><select aria-label="답변 템플릿" value={templateId} onChange={event => { setTemplate(event.target.value); const template = templates.find(row => row.id === event.target.value); if (template) changeBody(value(template, "body")); }}><option value="">Email template</option>{templates.map(row => <option key={row.id} value={row.id}>{value(row, "name")}</option>)}</select><select aria-label="케이스 답변 기준" value={caseId} onChange={event => setCase(event.target.value)}><option value="">Case policy</option>{cases.map(row => <option key={row.id} value={row.id}>{value(row, "name")}</option>)}</select></div><textarea required aria-label="메일 본문" rows={7} placeholder="Write your message…" value={body} onChange={event => changeBody(event.target.value)} />{threadId && <div className={styles.aiRow}><input id="mixmax-ai-instruction" aria-label="AI 작성 요청" placeholder="AI에게 답변 방향을 알려주세요" value={instruction} onChange={event => setInstruction(event.target.value)} /><button type="button" disabled={busy} onClick={() => void act("mixmaxGenerateDraft", { threadId, instruction, templateId, caseId }, "AI 초안을 작성했습니다. 내용을 검토해 주세요.").then(result => { if (typeof result?.body === "string") changeBody(result.body); })}>✧ Draft with AI</button></div>}<footer><button type="submit" className={styles.primary} disabled={busy || !accountId || sent}>{sent ? "Sent ✓" : busy ? "처리 중…" : "Send ↗"}</button><button type="button" className={styles.outline} disabled={busy} onClick={() => void act("mixmaxSaveDraft", { threadId, subject, to, body }, "초안을 저장했습니다.")}>Save draft</button><small>AI 초안은 검토 후 직접 발송합니다.</small></footer>{!accountId && <p className={styles.hint}>이 대화의 발신 메일 계정을 연결하면 답장할 수 있습니다. 초안 작성과 저장은 가능합니다.</p>}</form>;
}
function ItemEditor({ view, item, close, saved }: { view: View; item: MixmaxRow | null; close: () => void; saved: () => void }) {
  const [name, setName] = useState(value(item, "name")); const [subject, setSubject] = useState(value(item, "subject")); const [body, setBody] = useState(value(item, "body")); const [description, setDescription] = useState(value(item, "description")); const [email, setEmail] = useState(value(item, "email")); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function save(event: FormEvent) { event.preventDefault(); setBusy(true); try { await command(view === "contacts" ? "mixmaxSaveContact" : view === "cases" ? "mixmaxSaveCase" : view === "sequences" ? "mixmaxSaveSequence" : "mixmaxSaveTemplate", { id: item?.id, name, subject, body, description, email }); saved(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } }
  return <div className={styles.modalBackdrop}><form className={styles.itemModal} onSubmit={event => void save(event)} role="dialog" aria-label="Edit item"><header><h2>{item ? "Edit" : "New"} {view === "cases" ? "case" : view}</h2><button type="button" onClick={close} aria-label="편집창 닫기">×</button></header><label>Name<input required value={name} onChange={event => setName(event.target.value)} /></label>{view === "contacts" ? <label>Email<input type="email" value={email} onChange={event => setEmail(event.target.value)} /></label> : <>{view === "templates" ? <label>Subject<input value={subject} onChange={event => setSubject(event.target.value)} /></label> : <label>Description<input value={description} onChange={event => setDescription(event.target.value)} /></label>}<label>{view === "cases" ? "답변 기준 / 예시" : view === "sequences" ? "연락 순서와 단계별 초안" : "Body"}<textarea rows={12} value={body} onChange={event => setBody(event.target.value)} /></label></>}{view === "sequences" && <p className={styles.hint}>초안으로 저장됩니다. 자동 발송은 실행되지 않습니다.</p>}{error && <p role="alert" className={styles.error}>{error}</p>}<button disabled={busy} className={styles.primary}>{busy ? "저장 중…" : "Save"}</button></form></div>;
}
