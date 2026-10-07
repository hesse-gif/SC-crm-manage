"use client";

// FLU-0538 pixel-clone surface 05 (/flu/partners/{id} — 개요 tab). Operator decision B: keep the app font
// (Pretendard Std), structural pixel-clone of the frozen mockup content region; global shell = allowed
// deviation; residual = app-font glyph floor (no foreign-font embed). Reverse-engineered from the PNG
// mockup (05-partner-detail-proposal-final.png; no source HTML) — geometry is capture-tuned. Reuses the
// 07/08/09/10 learnings (lineHeight 1.2 vs app base 1.5; letterSpacing:normal on headings). Standalone dir
// (partnerDetailClone) so the real partnerDetail barrel stays untouched.
//
// FLU-0540 gap-closure: this is now the DEFAULT overview-tab layout, fed by
// `buildPartnerDetailSnapshotFromReal` (src/lib/partnerDetailData.ts) instead of the retired demo-seed
// callable. `present:false` is no longer "demo not seeded" — the caller passes it plus `emptyMessage` for
// the clone's own honest loading/empty/error state (never a fallback to a different layout).
import Link from "next/link";
import { Fragment } from "react";
import type { CSSProperties } from "react";
import type { PartnerDetailSnapshot } from "@/lib/partnerDetailData";
import { PARTNER_TAB_BAR_TOP_OFFSET } from "@/lib/partnerSurfaceTabs";

const ROOT: CSSProperties = {
  minHeight: "calc(100dvh - 64px)",
  background: "#ffffff",
  color: "#11131a",
  padding: "28px 28px",
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
const greenPill: CSSProperties = { display: "inline-flex", alignItems: "center", padding: "4px 12px", borderRadius: 999, fontSize: 13, fontWeight: 700, background: "#e7f8ee", color: "#159252" };
const tagPill: CSSProperties = { display: "inline-flex", alignItems: "center", padding: "4px 10px", borderRadius: 8, fontSize: 12, color: "#3b4150", background: "#f2f4f8", border: "1px solid #e6e8ee" };

export interface PartnerSurfaceTabLink {
  key: string;
  label: string;
  href: string;
}

export function PartnerDetailCloneView({
  snapshot: s,
  emptyMessage = "개요 데이터가 없습니다.",
  tabs,
  activeTabKey = "overview",
}: {
  snapshot: PartnerDetailSnapshot;
  emptyMessage?: string;
  tabs?: PartnerSurfaceTabLink[];
  activeTabKey?: string;
}) {
  const tabLinks = tabs ?? s.tabs.map((label) => ({ key: label, label, href: "#" }));
  if (!s.present) {
    return (
      <div data-testid="partner-detail-clone" style={ROOT}>
        <div style={{ fontSize: 24, fontWeight: 800 }}>파트너 상세</div>
        <SurfaceTabs tabs={tabLinks} activeTabKey={activeTabKey} activeLabel={s.activeTab} />
        {/* U6(b): 빈/로딩 상태가 실제 내용보다 훨씬 낮아 탭 전환 때 화면이 접혔다 — 같은 자리에
            머물도록 최소 높이를 준다(레이아웃만; 데이터 계약·폴백 금지 원칙은 그대로). */}
        <div style={{ ...card(), marginTop: 20, color: "#626979", minHeight: 360 }}>{emptyMessage}</div>
      </div>
    );
  }
  return (
    <div data-testid="partner-detail-clone" style={ROOT}>
      {/* top bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13, color: "#6f7583" }}>← {s.backLabel}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ padding: "8px 14px", border: "1px solid #e0e3e9", borderRadius: 10, fontSize: 13, color: "#3b4150" }}>{s.techInfoLabel}</span>
          <span style={{ fontSize: 18, color: "#9aa1b0" }}>···</span>
        </div>
      </div>

      {/* profile card */}
      <div style={card({ marginTop: 14, display: "flex", alignItems: "center", gap: 22 })}>
        <div style={{ position: "relative", width: 88, height: 88, flexShrink: 0 }}>
          {s.profileImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={s.profileImageUrl} alt="" style={{ width: 88, height: 88, borderRadius: "50%", objectFit: "cover", background: "#dfe4ee" }} />
          ) : (
            <div style={{ width: 88, height: 88, borderRadius: "50%", background: "#dfe4ee", display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 10, fontSize: 12, fontWeight: 800, color: "#7c8598", lineHeight: 1.25 }}>이미지<br />미연결</div>
          )}
          <span title={s.imageStatusLabel} aria-label={s.imageStatusLabel} style={{ position: "absolute", right: 4, bottom: 6, width: 16, height: 16, borderRadius: "50%", background: s.profileImageUrl ? "#22c15e" : "#f59e0b", border: "2px solid #fff" }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 26, fontWeight: 800 }}>{s.handle}</span>
            <span style={greenPill}>{s.statusBadge}</span>
          </div>
          <div style={{ marginTop: 8, fontSize: 15, color: "#3b4150" }}>{s.name}</div>
          <div data-testid="partner-provenance" style={{ marginTop: 6, fontSize: 12, color: "#6f7583" }}>
            출처 · 프로그램 {s.reasonProgram}
            {s.reasonCampaign && s.reasonCampaign !== "—" ? ` · 캠페인 ${s.reasonCampaign}` : ""}
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            {s.tags.map((t) => (
              <span key={t} style={tagPill}>{t}</span>
            ))}
          </div>
        </div>
      </div>

      {/* journey stepper */}
      <div style={card({ marginTop: 14, padding: "20px 22px" })}>
        <div style={{ display: "flex", alignItems: "stretch" }}>
          {s.steps.map((st, i) => {
            const last = i === s.steps.length - 1;
            const subColor = i >= 2 ? "#159252" : "#8a90a0";
            return (
              <Fragment key={st.label}>
                <div style={{ flex: last ? 1.2 : 1, borderRadius: 12, padding: st.active ? "10px 14px" : "2px 0", background: st.active ? "#eef4ff" : undefined }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#11131a" }}>{st.label}</div>
                  <div style={{ marginTop: 6, fontSize: 12, color: st.active ? "#159252" : subColor }}>{st.sub}</div>
                  {last && s.activeAt ? <div style={{ marginTop: 6, fontSize: 11, color: "#8a90a0" }}>{s.activeAt}</div> : null}
                </div>
                {!last ? <div style={{ display: "flex", alignItems: "center", padding: "0 8px", color: "#c2c8d4", fontSize: 16 }}>›</div> : null}
              </Fragment>
            );
          })}
        </div>
      </div>

      {/* tabs */}
      <SurfaceTabs tabs={tabLinks} activeTabKey={activeTabKey} activeLabel={s.activeTab} />

      {/* 3-col cards */}
      <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
        <div style={card()}>
          <div style={{ fontSize: 16, fontWeight: 700, paddingBottom: 12, borderBottom: "1px solid #eceef3" }}>{s.reasonTitle}</div>
          <div style={{ marginTop: 16, fontSize: 13, fontWeight: 700, color: "#3b4150" }}>{s.reasonLabel}</div>
          <div style={{ marginTop: 8, fontSize: 13, color: "#5b6172", lineHeight: 1.6 }}>{s.reasonText}</div>
          <div style={{ marginTop: 16, fontSize: 13, fontWeight: 700, color: "#3b4150" }}>{s.reasonProgramLabel}</div>
          <div style={{ marginTop: 6, fontSize: 13, color: "#5b6172" }}>{s.reasonProgram}</div>
          <div style={{ marginTop: 14, fontSize: 13, fontWeight: 700, color: "#3b4150" }}>{s.reasonCampaignLabel}</div>
          <div style={{ marginTop: 6, fontSize: 13, color: "#5b6172" }}>{s.reasonCampaign}</div>
        </div>

        <div style={card()}>
          <div style={{ fontSize: 16, fontWeight: 700, paddingBottom: 12, borderBottom: "1px solid #eceef3" }}>{s.videoTitle}</div>
          <div style={{ marginTop: 16, display: "flex", gap: 14 }}>
            <div style={{ position: "relative", width: 140, height: 84, borderRadius: 10, background: "#0f1830", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#cdd6ea", fontSize: 11 }}>
              <span style={{ position: "absolute", top: 8, left: 10, fontSize: 10, color: "#8fa0c4" }}>{s.videoThumbLabel}</span>
              <span style={{ width: 34, height: 34, borderRadius: "50%", background: "rgba(255,255,255,.85)", display: "flex", alignItems: "center", justifyContent: "center", color: "#0f1830" }}>▶</span>
              <span style={{ position: "absolute", right: 8, bottom: 6, fontSize: 10, background: "rgba(0,0,0,.6)", color: "#fff", padding: "1px 5px", borderRadius: 4 }}>{s.videoDuration}</span>
            </div>
            <div>
              <div style={{ fontSize: 13, color: "#3b4150" }}>{s.videoCanon} <span style={{ color: "#315af4" }}>↗</span></div>
              <div style={{ marginTop: 8, fontSize: 12, color: "#7a8090" }}>{s.videoType}</div>
            </div>
          </div>
          <p aria-label="영상 상태" style={{ marginTop: 18, padding: "12px 0", textAlign: "center", border: "1px solid #e0e3e9", borderRadius: 10, fontSize: 13, color: "#3b4150" }}>상태 · {s.videoButton}</p>
        </div>

        <div style={card()}>
          <div style={{ fontSize: 16, fontWeight: 700, paddingBottom: 12, borderBottom: "1px solid #eceef3" }}>{s.nextTitle}</div>
          <div style={{ marginTop: 16, fontSize: 13, fontWeight: 700, color: "#3b4150" }}>{s.nextStepLabel}</div>
          <div style={{ marginTop: 8, fontSize: 13, color: "#5b6172", lineHeight: 1.6 }}>{s.nextStepText}</div>
          <p aria-label="다음 조치 상태" style={{ marginTop: 16, padding: "12px 0", textAlign: "center", background: "#eef1f6", borderRadius: 10, fontSize: 13, fontWeight: 700, color: "#3b4150" }}>상태 · {s.nextButton}</p>
          <div style={{ marginTop: 20, fontSize: 13, fontWeight: 700, color: "#3b4150" }}>{s.recommendLabel}</div>
          <div style={{ marginTop: 8, fontSize: 13, color: "#5b6172" }}>{s.recommendText}</div>
        </div>
      </div>

      {/* 추가 정보 */}
      <div style={card({ marginTop: 18 })}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{s.moreTitle}</div>
            <div style={{ marginTop: 6, fontSize: 12, color: "#8a90a0" }}>{s.moreSub}</div>
          </div>
          <span style={{ fontSize: 14, color: "#9aa1b0" }}>⌃</span>
        </div>
        <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {s.moreRowsLeft.map((r) => (
              <MoreRow key={r.label} label={r.label} />
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {s.moreRowsMid.map((r) => (
              <MoreRow key={r.label} label={r.label} />
            ))}
          </div>
          <div style={{ background: "#fff8e8", border: "1px solid #f5e0a8", borderRadius: 12, padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#8a6a17" }}>⚠ {s.warnTitle}</div>
            <div style={{ marginTop: 8, fontSize: 12, color: "#93803f", lineHeight: 1.6 }}>{s.warnText}</div>
            <p aria-label="권한 안내" style={{ marginTop: 12, display: "inline-block", padding: "8px 14px", background: "#fff", border: "1px solid #e6d8a8", borderRadius: 9, fontSize: 12, color: "#8a6a17" }}>안내 · {s.warnButton}</p>
          </div>
        </div>
        <div style={{ marginTop: 16, textAlign: "right", fontSize: 11, color: "#9aa1b0" }}>🔒 {s.footerNote}</div>
      </div>
    </div>
  );
}

function MoreRow({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 16px", border: "1px solid #eceef3", borderRadius: 10 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "#3b4150" }}>
        <span style={{ width: 18, height: 18, borderRadius: 5, background: "#eef1f6" }} />
        {label}
      </span>
      <span style={{ color: "#c2c8d4" }}>›</span>
    </div>
  );
}

function SurfaceTabs({
  tabs,
  activeTabKey,
  activeLabel,
}: {
  tabs: PartnerSurfaceTabLink[];
  activeTabKey: string;
  activeLabel: string;
}) {
  return (
    <nav aria-label="파트너 상세 탭" role="tablist" style={{ marginTop: PARTNER_TAB_BAR_TOP_OFFSET, display: "flex", gap: 26, borderBottom: "1px solid #e1e4eb" }}>
      {tabs.map((t) => {
        const on = t.key === activeTabKey || t.label === activeLabel;
        return (
          <Link
            key={t.key}
            href={t.href}
            role="tab"
            aria-selected={on}
            data-testid={`partner-detail-tab-${t.key}`}
            style={{
              fontSize: 14,
              padding: "0 0 12px",
              color: on ? "#315af4" : "#6f7583",
              fontWeight: on ? 700 : 400,
              borderBottom: on ? "3px solid #315af4" : undefined,
              textDecoration: "none",
            }}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
