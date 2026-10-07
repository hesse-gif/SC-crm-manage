import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const liveSource = readFileSync(new URL("../src/lib/live.tsx", import.meta.url), "utf8");
const chatPageSource = readFileSync(new URL("../src/app/(app)/chat/page.tsx", import.meta.url), "utf8");

test("chat event refresh is a chat-route-only read refresh, not an idle polling path", () => {
  const effectStart = liveSource.indexOf("// Chat is refreshed by explicit app events and visibility recovery below.");
  assert.ok(effectStart > 0, "chat refresh policy must be documented in the Live provider");
  const effectEnd = liveSource.indexOf("}, [authReady, canRead, load, pathname, refreshKeys]);", effectStart);
  assert.ok(effectEnd > effectStart, "chat refresh tracking must stay inside the data refresh listener");
  const effect = liveSource.slice(effectStart, effectEnd);
  const executableEffect = effect.replace(/\/\/.*$/gm, "");

  assert.match(effect, /pathname\.startsWith\("\/chat"\)/, "sync must only arm on /chat routes");
  assert.doesNotMatch(effect, /setInterval|setTimeout/, "chat refresh must not use a fixed polling interval or recursive timeout");
  assert.match(effect, /document\.visibilityState === "visible"/, "visibility recovery must only run when the tab is visible");
  assert.match(effect, /window\.addEventListener\("flu:data-refresh", onRefresh\)/, "explicit data refresh events must re-read chat data");
  assert.match(effect, /document\.addEventListener\("visibilitychange", onVisible\)/, "chat data can recover when the tab becomes visible");
  assert.match(effect, /load\(refreshKeys,[\s\S]*appendKeys: \["conversations"\]/, "sync must re-read datasets and preserve drained conversation pages");
  assert.match(effect, /window\.dispatchEvent\(new CustomEvent\("chat:foreground-sync", \{ detail: \{ status: "success", finishedAtIso \} \}\)\)/, "successful sync must notify chat page listeners");
  assert.doesNotMatch(executableEffect, /receiveEmail|sendEmail|previewEmailDraft|markConversationRead|setConversationAutoReply/, "foreground sync must not call mutating chat/mail callables");
  assert.doesNotMatch(liveSource, /CHAT_FOREGROUND_REFRESH_INTERVAL_MS/, "the removed 30s foreground interval must not remain exported");
});

test("chat page converts successful foreground sync into a scoped conversation-list refresh", () => {
  const listenerStart = chatPageSource.indexOf("const onForegroundSync = (event: Event) => {");
  assert.ok(listenerStart > 0, "chat page must listen for foreground sync completion");
  const listenerEnd = chatPageSource.indexOf("window.addEventListener(\"flu:data-refresh\", onDataRefresh)", listenerStart);
  assert.ok(listenerEnd > listenerStart, "foreground sync listener must be registered with the data refresh listener");
  const listener = chatPageSource.slice(listenerStart, listenerEnd);

  assert.match(listener, /detail\?\.status !== "success"/, "failed sync events must not refresh visible lists");
  assert.match(listener, /invalidateConversationListCache\(\)/, "successful sync must invalidate the list cache before re-reading");
  assert.match(listener, /setAccountViewRefreshTick\(\(tick\) => tick \+ 1\)/, "successful sync must re-run the scoped account view loader");
  assert.match(chatPageSource, /data-testid="chat-foreground-sync-status"/, "chat UI must expose sync status for E2E/live-update proof");
  assert.doesNotMatch(chatPageSource, /30초|자동 동기화|동기화 중|최근 동기화/, "chat UI must not claim a timed or realtime sync loop");
});

test("selected conversation draft state does not use a read polling loop", () => {
  assert.doesNotMatch(
    chatPageSource,
    /schedulePoll|const poll = async|schedulePoll\(5_000\)|listConversations\(\{\s*ids: \[selectedConversationId\]/,
    "selected conversation state must not schedule repeated listConversations reads",
  );
});

test("chat foreground sync reports partial dataset refresh failures as sync errors", () => {
  const throwStart = liveSource.indexOf("if (options.throwOnError && bundle.partialLoadError)");
  assert.ok(throwStart > 0, "load() must inspect partialLoadError when throwOnError is requested");
  const throwBlock = liveSource.slice(throwStart, liveSource.indexOf("} catch (e) {", throwStart));

  assert.match(throwBlock, /throw new Error\("일부 채팅 데이터를 갱신하지 못했습니다\."\)/, "foreground sync must reject partial dataset failures after preserving successful rows");
  assert.match(liveSource, /throwOnError: pathname\.startsWith\("\/chat"\)/, "chat refresh must opt into partial-failure rejection only on chat routes");
  assert.match(liveSource, /publicCallableErrorMessage\(error, "채팅 갱신에 실패했습니다\."\)/, "rejected partial refreshes must surface as sync errors, not success events");
});
