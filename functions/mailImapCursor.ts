export function shouldAdvanceImapCursor(args: { readonly previousLastUid: number; readonly uid: number; readonly targetedScan: boolean }): boolean {
  if (!args.targetedScan) return true;
  return args.uid === args.previousLastUid + 1;
}

// W76-A: how far the stored cursor is behind the mailbox's actual highest UID
// (mailboxUidNext - 1). Zero in the healthy case; positive means the cursor claims
// "nothing new" while the mailbox disagrees — a cursor-corruption/poison signal that
// must not be silently absorbed into an "empty success" run.
export function computeCursorUidGap(mailboxUidNext: number, cursorLastUid: number): number {
  const highestUid = Math.max(0, Math.round(mailboxUidNext) - 1);
  const lastUid = Math.max(0, Math.round(cursorLastUid));
  return Math.max(0, highestUid - lastUid);
}
