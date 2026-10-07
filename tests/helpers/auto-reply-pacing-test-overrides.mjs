// Shared settings.automation override for emulator tests that drive the real, compiled
// processAutoReplyQueue() sweep (functions/chat-ai.ts) against the Firestore emulator.
//
// auto-reply-pacing (2026-09-17): functions/_settings-mock.ts defaults
// automation.autoReplyBusinessHoursKst to { enabled: true, startHour: 10, startMinute: 0,
// endHour: 18, endMinute: 30, weekdaysOnly: true } and added a per-pass claim cap
// (maxAutoRepliesPerPass, default 10) plus an auto_reply-only hourly cap
// (maxHourlyAutoSends, default 20). readSettings() deep-merges whatever a test writes to
// settings/default over that default, so any test that does not explicitly override these
// fields inherits them — making the sweep's claim-time due-check
// (autoReplyIsDue(data, nowIso, businessHours) / claimAutoReplyJob(doc, nowIso, businessHours))
// silently defer jobs outside 10:00-18:30 KST on weekdays, or once >10 jobs land in one pass,
// or once >20 sends land in the current KST hour — flaky failures that depend on wall-clock
// time rather than the behavior under test.
//
// Spread this into the `automation` object a test writes to settings/default so the sweep is
// deterministic regardless of when/how often the suite runs. Fields a test is deliberately
// exercising (e.g. maxDailyAutoSends in a daily-cap test) should be set AFTER spreading this so
// they win.
export function autoReplyPacingTestOverrides(overrides = {}) {
  return {
    autoReplyBusinessHoursKst: { enabled: false, startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, weekdaysOnly: false },
    maxAutoRepliesPerPass: 50,
    maxHourlyAutoSends: 200,
    ...overrides,
  };
}
