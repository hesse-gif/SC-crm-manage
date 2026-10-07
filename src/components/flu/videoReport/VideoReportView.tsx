"use client";

// FLU-0538 pixel-clone surface 10 (/flu/report/video-performance — 영상 성과). Operator decision B: keep
// the app font (Pretendard Std), structural pixel-clone of the frozen mockup content region; global shell
// = allowed deviation; residual = app-font glyph floor (no foreign-font embed). Reverse-engineered from the
// PNG mockup (10-video-performance-settlement-ledger-selected.png; no source HTML) — geometry is capture-
// tuned. Reuses 07/08/09 learnings (lineHeight 1.2 vs app base 1.5; letterSpacing:normal on h3; elements
// without an explicit font-size inherit body-default 16px). Data comes from getVideoReportSnapshot
// (demo-seeded today); present:false → the caller renders the real report page untouched. minHeight fills
// the content viewport so any below-fold content stays out of the capture region.
import type { CSSProperties, ReactNode } from "react";
import type { ReportTone, VideoReportSnapshot } from "@/lib/videoReportData";

const TONE: Record<ReportTone, CSSProperties> = {
  green: { background: "#e7f8ee", color: "#159252" },
  blue: { background: "#ebefff", color: "#315af4" },
  amber: { background: "#fff5d9", color: "#bf7700" },
  red: { background: "#ffe9e9", color: "#cf3d3d" },
  purple: { background: "#f1eaff", color: "#783cd7" },
};
const RING: Record<ReportTone, string> = {
  green: "#159252",
  blue: "#315af4",
  amber: "#bf7700",
  red: "#cf3d3d",
  purple: "#783cd7",
};

function card(extra?: CSSProperties): CSSProperties {
  return {
    background: "#fff",
    border: "1px solid #e6e8ee",
    borderRadius: 14,
    padding: 18,
    boxShadow: "0 1px 2px rgba(20,25,40,.03)",
    ...extra,
  };
}
function Pill({ tone, children }: { tone: ReportTone; children: ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", padding: "4px 10px", borderRadius: 8, fontSize: 12, fontWeight: 700, ...TONE[tone] }}>
      {children}
    </span>
  );
}
function Dropdown({ label }: { label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "space-between", gap: 10, minWidth: 130, height: 34, padding: "0 12px", border: "1px solid #e0e3e9", borderRadius: 9, fontSize: 12, color: "#3b4150", background: "#fff" }}>
      {label}
      <span style={{ color: "#9aa1b0" }}>▾</span>
    </span>
  );
}

const ROOT: CSSProperties = {
  minHeight: "calc(100dvh - 64px)",
  background: "#f7f8fb",
  color: "#11131a",
  padding: "24px 28px",
  fontSize: 13,
  lineHeight: 1.2,
};

export function VideoReportView({ snapshot: s }: { snapshot: VideoReportSnapshot }) {
  if (!s.present) {
    return (
      <div data-testid="video-report-view" style={ROOT}>
        <div style={{ fontSize: 28, fontWeight: 800 }}>영상 성과</div>
        <div style={{ ...card(), marginTop: 24, fontSize: 13, color: "#626979" }}>
          리포트 스냅샷이 아직 없습니다. 데모 시드(scripts/seed-flu-0538-demo.mjs) 적용 후 표시됩니다.
        </div>
      </div>
    );
  }

  const maxCum = Math.max(1, ...s.chartPoints.map((p) => p.cumulative));
  const maxDaily = Math.max(1, ...s.chartPoints.map((p) => p.daily));
  const cw = 640;
  const ch = 112;
  const step = s.chartPoints.length > 1 ? cw / (s.chartPoints.length - 1) : cw;
  const cumPts = s.chartPoints.map((p, i) => `${i * step},${ch - (p.cumulative / maxCum) * ch}`).join(" ");
  const eligPts = s.chartPoints.map((p, i) => `${i * step},${ch - (p.eligible / maxCum) * ch}`).join(" ");

  return (
    <div data-testid="video-report-view" style={ROOT}>
      {/* tabs */}
      <div style={{ display: "flex", gap: 30, borderBottom: "1px solid #e1e4eb" }}>
        {s.tabs.map((t) => {
          const on = t === s.activeTab;
          return (
            <span key={t} style={{ fontSize: 14, padding: "0 0 12px", color: on ? "#315af4" : "#6f7583", fontWeight: on ? 700 : 400, borderBottom: on ? "3px solid #315af4" : undefined }}>
              {t}
            </span>
          );
        })}
      </div>

      {/* title row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginTop: 22 }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 800 }}>{s.title}</div>
          <div style={{ marginTop: 8, fontSize: 13, color: "#727887" }}>{s.subtitle}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ display: "inline-flex", border: "1px solid #e0e3e9", borderRadius: 9, overflow: "hidden" }}>
              {s.periodModes.map((m) => {
                const on = m === s.activePeriod;
                return (
                  <span key={m} style={{ padding: "8px 14px", fontSize: 12, fontWeight: on ? 700 : 500, background: on ? "#eef2ff" : "#fff", color: on ? "#2c55f4" : "#3b4150" }}>
                    {m}
                  </span>
                );
              })}
            </div>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10, height: 36, padding: "0 12px", border: "1px solid #e0e3e9", borderRadius: 9, fontSize: 12, color: "#3b4150", background: "#fff" }}>
              {s.dateRange}
              <span style={{ color: "#9aa1b0" }}>▤</span>
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            {s.filters.map((f) => (
              <Dropdown key={f} label={f} />
            ))}
          </div>
        </div>
      </div>

      {/* KPI cards */}
      <div style={{ marginTop: 13, display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
        {s.kpis.map((k) => (
          <div key={k.label} style={card({ padding: 16 })}>
            <div style={{ fontSize: 13, color: "#727887" }}>{k.label} ⓘ</div>
            <div style={{ marginTop: 9, display: "flex", alignItems: "baseline", gap: 10 }}>
              <span style={{ fontSize: 28, fontWeight: 800 }}>{k.value}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#315af4" }}>{k.delta}</span>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: "#7a8090" }}>{k.compare}</div>
            <div style={{ marginTop: 6, fontSize: 11, color: "#9aa1b0" }}>{k.updated}</div>
          </div>
        ))}
      </div>

      {/* chart + funnel */}
      <div style={{ marginTop: 13, display: "grid", gridTemplateColumns: "1.55fr 1fr", gap: 16 }}>
        <div style={card({ height: 200, overflow: "hidden" })}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{s.chartTitle}</div>
            <div style={{ display: "flex", gap: 16, fontSize: 11, color: "#6f7583" }}>
              {s.chartLegend.map((l) => (
                <span key={l}>— {l}</span>
              ))}
            </div>
          </div>
          <div style={{ position: "relative", marginTop: 10, display: "flex", gap: 6 }}>
            <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", fontSize: 10, color: "#9aa1b0" }}>
              <span>(누적)</span>
              <span>6.0M</span>
              <span>4.5M</span>
              <span>3.0M</span>
              <span>1.5M</span>
              <span>0</span>
            </div>
            <svg width={cw} height={ch} viewBox={`0 0 ${cw} ${ch}`} style={{ flex: 1, overflow: "visible" }}>
              {s.chartPoints.map((p, i) => {
                const bh = (p.daily / maxDaily) * (ch * 0.5);
                return <rect key={i} x={i * step - 10} y={ch - bh} width={20} height={bh} fill="#c9d6ff" rx={3} />;
              })}
              <polyline points={eligPts} fill="none" stroke="#9db4ff" strokeWidth={2} strokeDasharray="5 4" />
              <polyline points={cumPts} fill="none" stroke="#315af4" strokeWidth={2.5} />
              <circle cx={(s.chartPoints.length - 1) * step} cy={ch - (s.chartPoints[s.chartPoints.length - 1].cumulative / maxCum) * ch} r={5} fill="#315af4" stroke="#fff" strokeWidth={2} />
            </svg>
            <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", fontSize: 10, color: "#9aa1b0", textAlign: "right", minWidth: 30 }}>
              <span>(일일)</span>
              <span>1.2M</span>
              <span>900K</span>
              <span>600K</span>
              <span>300K</span>
              <span>0</span>
            </div>
            <span style={{ position: "absolute", top: -4, right: 46, fontSize: 10, color: "#9aa1b0", textAlign: "right", lineHeight: 1.3 }}>{s.chartDeadlineNote}</span>
            <span style={{ position: "absolute", top: 22, right: 128, fontSize: 11, fontWeight: 700, color: "#315af4", background: "#eef2ff", border: "1px solid #cdd8ff", borderRadius: 7, padding: "3px 8px" }}>{s.chartTodayNote}</span>
          </div>
          <div style={{ marginTop: 6, marginLeft: 34, marginRight: 34, fontSize: 11, color: "#9aa1b0", display: "flex", justifyContent: "space-between" }}>
            {s.chartPoints.map((p) => (
              <span key={p.label}>{p.label}</span>
            ))}
          </div>
        </div>

        <div style={card({ height: 200, overflow: "hidden" })}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{s.funnelTitle}</div>
          <div style={{ marginTop: 22, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            {s.funnelStages.map((st, i) => (
              <div key={st.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ width: 52, height: 52, borderRadius: "50%", border: `2px solid ${RING[st.tone]}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 800, color: RING[st.tone] }}>
                    {st.value}
                  </div>
                  <div style={{ marginTop: 10, fontSize: 12, color: "#3b4150" }}>{st.label}</div>
                </div>
                {i < s.funnelStages.length - 1 ? <span style={{ color: "#c2c8d4", fontSize: 16 }}>→</span> : null}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 26, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "#7a8090" }}>{s.funnelNote}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#315af4" }}>{s.funnelLink} ↗</span>
          </div>
        </div>
      </div>

      {/* table */}
      <div style={{ marginTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>
          {s.tableTitle} <span style={{ color: "#315af4" }}>{s.tableCount}</span>
        </div>
        <div style={{ display: "flex", gap: 10, fontSize: 12, color: "#3b4150" }}>
          <span style={{ padding: "7px 12px", border: "1px solid #e0e3e9", borderRadius: 9 }}>내보내기 ⭳</span>
          <span style={{ padding: "7px 12px", border: "1px solid #e0e3e9", borderRadius: 9 }}>열 설정 ⚙</span>
        </div>
      </div>
      <div style={card({ marginTop: 12, padding: 0 })}>
        <div style={{ display: "grid", gridTemplateColumns: "34px 1.5fr 1.2fr 1.6fr 1fr .9fr .8fr .9fr 1fr .7fr 1fr .9fr .8fr", gap: 8, alignItems: "center", fontSize: 11, color: "#8a90a0", padding: "13px 16px", borderBottom: "1px solid #eceef3" }}>
          <span />
          {s.tableColumns.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        {s.tableRows.map((r) => (
          <div key={r.creatorHandle} style={{ display: "grid", gridTemplateColumns: "34px 1.5fr 1.2fr 1.6fr 1fr .9fr .8fr .9fr 1fr .7fr 1fr .9fr .8fr", gap: 8, alignItems: "center", fontSize: 12, padding: "12px 16px", borderBottom: "1px solid #f0f2f6", background: r.selected ? "#f6f8ff" : undefined }}>
            <span style={{ width: 16, height: 16, borderRadius: 4, border: `1px solid ${r.selected ? "#315af4" : "#c8cdd8"}`, background: r.selected ? "#315af4" : "#fff" }} />
            <span>
              <b style={{ fontWeight: 700 }}>{r.creatorName}</b>
              <span style={{ display: "block", fontSize: 11, color: "#8a90a0" }}>{r.creatorHandle}</span>
            </span>
            <span>
              {r.program}
              <span style={{ display: "block", fontSize: 11, color: "#8a90a0" }}>{r.campaign}</span>
            </span>
            <span>{r.videoTitle}</span>
            <span>
              {r.country}
              <span style={{ display: "block", fontSize: 11, color: "#8a90a0" }}>{r.countrySource}</span>
            </span>
            <b style={{ fontWeight: 700 }}>{r.totalViews}</b>
            <span style={{ color: "#315af4", fontWeight: 700 }}>{r.dailyDelta}</span>
            <span>{r.eligibleViews}</span>
            <span style={{ fontSize: 11 }}>{r.deadline}</span>
            <span>{r.cpm}</span>
            <b style={{ fontWeight: 700 }}>{r.amount}</b>
            <span><Pill tone={r.statusTone}>{r.statusLabel}</Pill></span>
            <span style={{ fontSize: 11, color: "#8a90a0" }}>{r.lastSync}</span>
          </div>
        ))}
      </div>

      {/* detail panel */}
      <div style={card({ marginTop: 12, display: "grid", gridTemplateColumns: "300px 1fr", gap: 20 })}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{s.detailVideoTitle}</div>
          <div style={{ marginTop: 6, fontSize: 12, color: "#7a8090" }}>{s.detailCreator}</div>
          <div style={{ marginTop: 4, fontSize: 12, color: "#7a8090" }}>{s.detailCampaign}</div>
          <div style={{ marginTop: 14, fontSize: 12 }}>게시일 <span style={{ color: "#3b4150" }}>{s.detailPublished}</span></div>
          <div style={{ marginTop: 6, fontSize: 12 }}>영상 링크 <span style={{ color: "#315af4" }}>{s.detailLink}</span></div>
          <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <span style={{ padding: "8px 12px", border: "1px solid #e0e3e9", borderRadius: 9, fontSize: 12 }}>YouTube 열기 ↗</span>
            <span style={{ padding: "8px 12px", border: "1px solid #e0e3e9", borderRadius: 9, fontSize: 12 }}>크리에이터 프로필</span>
            <span style={{ padding: "8px 12px", border: "1px solid #e0e3e9", borderRadius: 9, fontSize: 12 }}>메모 추가</span>
          </div>
        </div>
        <div>
          <div style={{ display: "flex", gap: 22, borderBottom: "1px solid #e1e4eb" }}>
            {s.detailTabs.map((t) => {
              const on = t === s.detailActiveTab;
              return (
                <span key={t} style={{ fontSize: 13, padding: "0 0 10px", color: on ? "#315af4" : "#6f7583", fontWeight: on ? 700 : 400, borderBottom: on ? "3px solid #315af4" : undefined }}>
                  {t}
                </span>
              );
            })}
          </div>
          <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1.1fr 1fr 1fr 1fr 1fr", gap: 16, fontSize: 12 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700 }}>최근 7일 누적 추이</div>
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#7a8090", marginBottom: 8 }}>진단 요약</div>
              {s.detailDiagnosis.map((d) => (
                <div key={d} style={{ marginTop: 8 }}>✓ {d}</div>
              ))}
            </div>
            {[
              { title: "정확한 측정 구간", lines: s.detailMeasure },
              { title: "제외 사유", lines: s.detailExclusions },
              { title: "정산 내역", lines: s.detailLedger },
            ].map((col) => (
              <div key={col.title}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#7a8090", marginBottom: 8 }}>{col.title}</div>
                {col.lines.map((l) => (
                  <div key={l.label} style={{ marginTop: 8, display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ color: "#7a8090" }}>{l.label}</span>
                    <b style={{ fontWeight: 700 }}>{l.value}</b>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
