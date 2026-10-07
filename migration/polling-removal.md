# Chat polling removal

Mixmax chat no longer starts automatic read polling while the tab is idle.

Removed paths:

- `/chat` foreground dataset refresh every 30 seconds in `LiveDataProvider`.
- Selected conversation draft-status polling every 5 seconds in the chat page.

Remaining refresh paths are session/user driven:

- Initial route/account reads on mount and scope changes.
- `requestDataRefresh()` after receive, send, read, attribution, and auto-reply actions.
- Manual receive/refresh controls.
- `chat:foreground-sync` as a future push/session event adapter. A successful event invalidates the scoped conversation-list cache and re-runs the mounted account view loader.

Do not add another client interval as a replacement. A future realtime transport should publish a targeted event after the backend has new mail/conversation data, then reuse the existing `chat:foreground-sync` listener in `src/app/(app)/chat/page.tsx`.
