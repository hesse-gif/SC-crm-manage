"use client";

// FLU-0538 pixel-clone surface 06 (/flu/influencers/{id} — Journey tab, 관리 상세). Operator decision B:
// keep the app font (Pretendard Std), structural pixel-clone of the frozen mockup content region; global
// shell = allowed deviation; residual = app-font glyph floor (no foreign-font embed). Reverse-engineered
// from the PNG mockup (06-manage-detail-proposal-final.png; no source HTML) — geometry is capture-tuned.
// Reuses the 05/07/08/09/10 learnings (lineHeight 1.2 vs app base 1.5). Standalone dir so the real
// influencer page internals stay untouched.
//
// FLU-0540 gap-closure: this is now the DEFAULT layout for `/flu/influencers/{id}` — fed by
// `buildManagementDetailSnapshotFromReal` (defined in the route page) instead of the retired demo-seed
// callable. `present:false` is no longer "demo not seeded" — the caller passes it plus `emptyMessage` for
// the clone's own honest loading/empty/error state (never a fallback to a different layout).

import type { CSSProperties } from "react";
import type { ManagementDetailSnapshot, StepState } from "@/lib/managementDetailData";

const ROOT: CSSProperties = {
  minHeight: "calc(100dvh - 64px)",
  background: "#f7f8fb",
  color: "#11131a",
  padding: "20px 24px",
  fontSize: 13,
  lineHeight: 1.2,
};
function card(extra?: CSSProperties): CSSProperties {
  return {
    background: "#fff",
    border: "1px solid #e6e8ee",
    borderRadius: 16,
    padding: 22,
    ...extra,
  };
}
const RING: Record<StepState, string> = { done: "#22a35a", current: "#315af4", pending: "#cdd2dc" };

export function ManagementDetailCloneView({
  snapshot: s,
  emptyMessage = "관리 상세 데이터가 없습니다.",
}: {
  snapshot: ManagementDetailSnapshot;
  emptyMessage?: string;
}) {
  if (!s.present) {
    return (
      <div data-testid="management-detail-clone" style={ROOT}>
        <div style={{ fontSize: 24, fontWeight: 800 }}>관리 상세</div>
        <div style={{ ...card(), marginTop: 20, color: "#626979" }}>{emptyMessage}</div>
      </div>
    );
  }
  return (
    <div data-testid="management-detail-clone" style={ROOT}>
      {/* profile card */}
      <div style={card({ display: "flex", alignItems: "flex-start", gap: 20 })}>
        <div style={{ width: 74, height: 74, borderRadius: "50%", background: "#dfe4ee", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, fontWeight: 800, color: "#7c8598" }}>
          {s.name.slice(0, 1)}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 24, fontWeight: 800 }}>{s.name}</div>
          <div style={{ marginTop: 4, fontSize: 13, color: "#7a8090" }}>{s.handle}</div>
          <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 22, fontSize: 13 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6, color: "#3b4150" }}>
              <span style={{ color: "#e33b3b" }}>▶</span> {s.platform}
            </span>
            <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <b style={{ fontWeight: 800 }}>{s.subscribers}</b>
              <span style={{ fontSize: 11, color: "#9aa1b0" }}>{s.subscribersLabel}</span>
            </span>
            <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span>{s.regionFlag} {s.region}</span>
              <span style={{ fontSize: 11, color: "#9aa1b0" }}>{s.regionLabel}</span>
            </span>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 999, fontSize: 12, fontWeight: 700, background: "#e7f8ee", color: "#159252" }}>
            ● {s.statusBadge}
          </span>
          <div style={{ marginTop: 12, fontSize: 11, color: "#9aa1b0" }}>{s.updatedAt}</div>
        </div>
      </div>

      {/* status strip */}
      <div style={card({ marginTop: 12, padding: 0, display: "grid", gridTemplateColumns: "repeat(5,1fr)" })}>
        {s.statusCells.map((c, i) => (
          <div key={c.label} style={{ padding: "18px 20px", borderLeft: i === 0 ? undefined : "1px solid #eef0f4" }}>
            <div style={{ fontSize: 12, color: "#8a90a0" }}>{c.label}</div>
            <div style={{ marginTop: 8, fontSize: 15, fontWeight: 700, color: c.accent ? "#2c55f4" : "#11131a" }}>{c.value}</div>
            {c.sub ? <div style={{ marginTop: 6, fontSize: 11, color: "#9aa1b0" }}>{c.sub}</div> : null}
          </div>
        ))}
      </div>

      {/* tabs */}
      <div style={{ marginTop: 16, display: "flex", gap: 24, borderBottom: "1px solid #e1e4eb" }}>
        {s.tabs.map((t) => {
          const on = t === s.activeTab;
          return (
            <span key={t} style={{ fontSize: 14, padding: "0 0 12px", color: on ? "#315af4" : "#6f7583", fontWeight: on ? 700 : 400, borderBottom: on ? "3px solid #315af4" : undefined }}>
              {t}
            </span>
          );
        })}
      </div>

      {/* journey stepper */}
      <div style={card({ marginTop: 16, padding: "28px 26px" })}>
        <div style={{ display: "flex", alignItems: "flex-start" }}>
          {s.steps.map((st, i) => {
            const next = s.steps[i + 1];
            let lineColor = "#e1e4eb";
            if (next) {
              if (next.state === "current") lineColor = "#315af4";
              else if (st.state === "done" && next.state === "done") lineColor = "#22a35a";
            }
            return (
              <div key={st.no} style={{ flex: 1, position: "relative", textAlign: "center" }}>
                {next ? <div style={{ position: "absolute", top: 17, left: "50%", width: "100%", height: 2, background: lineColor }} /> : null}
                <div style={{ position: "relative", zIndex: 1, margin: "0 auto", width: 36, height: 36, borderRadius: "50%", border: `2px solid ${RING[st.state]}`, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", color: RING[st.state] }}>
                  {st.state === "done" ? <span style={{ fontSize: 15, fontWeight: 800 }}>✓</span> : st.state === "current" ? <span style={{ width: 14, height: 14, borderRadius: "50%", background: "#315af4" }} /> : null}
                </div>
                <div style={{ marginTop: 14, fontSize: 12, color: "#9aa1b0" }}>{st.no}</div>
                <div style={{ marginTop: 4, fontSize: 14, fontWeight: 700, color: "#11131a" }}>{st.label}</div>
                <div style={{ marginTop: 6, fontSize: 12, color: st.state === "current" ? "#315af4" : "#9aa1b0" }}>{st.sub}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 2-col cards */}
      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1.35fr", gap: 16 }}>
        <div style={card()}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{s.inflowTitle}</div>
          {s.inflowRows.map((r, i) => (
            <div key={r.label} style={{ marginTop: i === 0 ? 20 : 0, paddingTop: i === 0 ? 0 : 18, paddingBottom: 18, borderBottom: i < s.inflowRows.length - 1 ? "1px solid #f0f2f6" : undefined, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, color: "#7a8090" }}>{r.label}</span>
              <b style={{ fontSize: 14, fontWeight: 700, color: "#11131a" }}>{r.value}</b>
            </div>
          ))}
        </div>

        <div style={card()}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{s.activityTitle}</div>
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            {s.activities.map((a) => (
              <div key={a.title + a.time} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", border: "1px solid #eef0f4", borderRadius: 12 }}>
                <span style={{ width: 34, height: 34, borderRadius: "50%", flexShrink: 0, background: a.iconTone, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 14 }}>●</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#11131a" }}>{a.title}</div>
                  <div style={{ marginTop: 4, fontSize: 11, color: "#9aa1b0" }}>{a.time}</div>
                </div>
                {a.button ? (
                  <>
                    <span style={{ fontSize: 12, color: "#7a8090" }}>{a.right}</span>
                    <span style={{ padding: "8px 14px", background: "#315af4", borderRadius: 9, fontSize: 12, fontWeight: 700, color: "#fff" }}>{a.button}</span>
                  </>
                ) : (
                  <span style={{ fontSize: 12, color: "#9aa1b0" }}>{a.right}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* bottom row */}
      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "260px 1fr", gap: 16 }}>
        <div style={card({ display: "flex", alignItems: "center", gap: 12 })}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#22c15e", flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{s.syncStatus}</div>
            <div style={{ marginTop: 4, fontSize: 11, color: "#9aa1b0" }}>{s.syncSource}</div>
          </div>
        </div>
        <div style={card()}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{s.memoTitle}</div>
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <span style={{ height: 10, borderRadius: 6, background: "#eef1f6", width: "72%" }} />
            <span style={{ height: 10, borderRadius: 6, background: "#eef1f6", width: "40%" }} />
          </div>
        </div>
      </div>

      {/* footer bar */}
      <div style={{ marginTop: 16, padding: "16px 20px", background: "#eef2fb", border: "1px solid #dbe3f5", borderRadius: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13, color: "#3b4150" }}>ⓘ {s.footerNote}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#315af4" }}>{s.footerLink}</span>
      </div>
    </div>
  );
}
