"use client";

// FLU-0538 pixel-clone surface 07 (/flu/partners/{id}?tab=performance — 성과·정산). Operator decision B:
// keep the app font (Pretendard Std), structural pixel-clone of the frozen mockup #settlement content
// region; global shell = allowed deviation; residual = app-font glyph floor (no foreign-font embed).
// Ported 1:1 from artifacts/ux-audit-20260719/07-view-settlement-scp-review-mockups.html (#settlement)
// using the mockup's exact px geometry via inline styles (learnings from surface 08: line-height pinned
// to the mockup default ~1.2 vs the app base 1.5; letterSpacing:normal overrides the app h3 rule). Data
// comes from getPartnerSettlementSnapshot (demo-seeded today); present:false renders an honest empty state.
// minHeight fills the content viewport so any below-fold content stays out of the 07 capture region.
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import type {
  PartnerSettlementSnapshot,
  SettlementTone,
} from "@/lib/partnerSettlementData";
import { PARTNER_TAB_BAR_TOP_OFFSET } from "@/lib/partnerSurfaceTabs";

const PILL_TONE: Record<SettlementTone, CSSProperties> = {
  green: { background: "#e7f8ee", color: "#159252" },
  blue: { background: "#ebefff", color: "#315af4" },
  amber: { background: "#fff5d9", color: "#bf7700" },
  red: { background: "#ffe9e9", color: "#cf3d3d" },
  purple: { background: "#f1eaff", color: "#783cd7" },
};

function Pill({ tone, children }: { tone: SettlementTone; children: ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 28,
        padding: "6px 12px",
        borderRadius: 99,
        fontSize: 12,
        fontWeight: 700,
        ...PILL_TONE[tone],
      }}
    >
      {children}
    </span>
  );
}

function card(extra?: CSSProperties): CSSProperties {
  return {
    background: "#fff",
    border: "1px solid #e0e3e9",
    borderRadius: 14,
    padding: 18,
    boxShadow: "0 1px 2px rgba(20,25,40,.03)",
    ...extra,
  };
}

function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 700 }}>{title}</div>
      {sub ? <div style={{ marginTop: 6, fontSize: 11, fontWeight: 500, color: "#777d8b" }}>{sub}</div> : null}
    </div>
  );
}

const ROOT: CSSProperties = {
  minHeight: "calc(100dvh - 64px)",
  background: "#f7f8fb",
  color: "#11131a",
  padding: "28px 32px",
  fontSize: 13,
  lineHeight: 1.2,
};

const TABS = ["개요", "Journey", "영상", "성과·정산", "감사"];
const TABLE_COLS = "2.4fr .85fr .8fr .85fr 1.15fr .8fr .7fr";

export interface PartnerSurfaceTabLink {
  key: string;
  label: string;
  href: string;
}

export function PartnerSettlementView({
  snapshot,
  tabs,
  activeTabKey = "performance",
}: {
  snapshot: PartnerSettlementSnapshot;
  tabs?: PartnerSurfaceTabLink[];
  activeTabKey?: string;
}) {
  const tabLinks = tabs ?? TABS.map((label) => ({ key: label, label, href: "#" }));
  if (!snapshot.present) {
    return (
      <div data-testid="partner-settlement-view" style={ROOT}>
        <div style={{ fontSize: 29, fontWeight: 800, marginTop: 20 }}>성과·정산</div>
        <SurfaceTabs tabs={tabLinks} activeTabKey={activeTabKey} activeLabel={snapshot.activeTab} />
        <div style={{ ...card(), marginTop: 24, fontSize: 13, color: "#626979" }}>
          정산 스냅샷이 아직 없습니다.
        </div>
      </div>
    );
  }

  return (
    <div data-testid="partner-settlement-view" style={ROOT}>
      <div style={{ fontSize: 13, color: "#727887" }}>{snapshot.topline}</div>
      <div style={{ marginTop: 20, display: "grid", gridTemplateColumns: "1.25fr 1fr", gap: 16, alignItems: "stretch" }}>
        <div style={card({ display: "flex", alignItems: "center", gap: 16, padding: 16 })}>
          <div style={{ width: 58, height: 58, borderRadius: "50%", overflow: "hidden", background: "#dfe4ee", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 800, color: "#7c8598" }}>
            {snapshot.profileImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={snapshot.profileImageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <span style={{ textAlign: "center", fontSize: 10, lineHeight: 1.25 }}>이미지<br />미연결</span>
            )}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 24, fontWeight: 800 }}>
              <span>{snapshot.handle}</span>
              <Pill tone="green">{snapshot.statusPillText}</Pill>
            </div>
            <div style={{ marginTop: 6, fontSize: 13, color: "#565d6d" }}>{snapshot.displayName}</div>
            <div data-testid="partner-provenance" style={{ marginTop: 5, fontSize: 11, color: "#687082" }}>
              출처 · 프로그램 {snapshot.programLabel}
              {snapshot.campaignLabel !== "캠페인 미지정" ? ` · 캠페인 ${snapshot.campaignLabel}` : ""}
            </div>
            <div style={{ marginTop: 5, fontSize: 11, color: snapshot.profileImageUrl ? "#159252" : "#b7791f" }}>{snapshot.imageStatusLabel}</div>
            <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", fontSize: 11, color: "#687082" }}>
              <span style={{ padding: "5px 8px", borderRadius: 8, background: "#f1f3f7", border: "1px solid #e3e6ed" }}>{snapshot.programLabel}</span>
              {snapshot.campaignLabel !== "캠페인 미지정" ? (
                <span style={{ padding: "5px 8px", borderRadius: 8, background: "#f1f3f7", border: "1px solid #e3e6ed" }}>{snapshot.campaignLabel}</span>
              ) : null}
            </div>
          </div>
        </div>
        <div style={card({ display: "flex", gap: 12, padding: 14 })}>
          <div style={{ width: 112, height: 64, borderRadius: 10, overflow: "hidden", background: "#101828", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#d5dbea", fontSize: 11 }}>
            {snapshot.heroVideo?.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={snapshot.heroVideo.thumbnailUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              "썸네일 미연결"
            )}
          </div>
          <div style={{ minWidth: 0, fontSize: 12, color: "#616979" }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#11131a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{snapshot.heroVideo?.title ?? "승인 영상 없음"}</div>
            <div style={{ marginTop: 6 }}>{snapshot.heroVideo?.channel ?? "채널 —"} · {snapshot.heroVideo?.publishedAt ?? "게시일 —"}</div>
            <div style={{ marginTop: 6 }}>{snapshot.heroVideo?.metadata ?? "영상 메타데이터 없음"}</div>
            <div style={{ marginTop: 6, color: "#315af4" }}>{snapshot.countryProvenance}</div>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 8, fontSize: 13, color: "#727887" }}>{snapshot.subtitle}</div>

      {/* tabs */}
      <SurfaceTabs tabs={tabLinks} activeTabKey={activeTabKey} activeLabel={snapshot.activeTab} />

      <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12 }}>
        {snapshot.ledgers.map((ledger) => (
          <div key={ledger.label} style={card({ padding: 14, display: "flex", alignItems: "center", justifyContent: "space-between" })}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 800 }}>{ledger.label}</div>
              <div style={{ marginTop: 5, fontSize: 11, color: "#777d8b" }}>{ledger.micro}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Pill tone={ledger.tone}>{ledger.tone === "green" ? "검증" : "임시"}</Pill>
              <b style={{ fontSize: 18 }}>{ledger.value}</b>
            </div>
          </div>
        ))}
      </div>

      {/* 4 KPI cards */}
      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
        {snapshot.kpis.map((k) => (
          <div key={k.label} style={card()}>
            <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 700, letterSpacing: "normal" }}>
              {k.label}
              <Pill tone={k.pillTone}>{k.pillText}</Pill>
            </h3>
            <div style={{ marginTop: 20, fontSize: 30, fontWeight: 800 }}>{k.value}</div>
            <div style={{ marginTop: 8, fontSize: 11, color: "#777e8d" }}>{k.micro}</div>
          </div>
        ))}
      </div>

      {/* chart (2fr) | calc (1.1fr) */}
      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "2fr 1.1fr", gap: 16 }}>
        <div style={card({ height: 240 })}>
          <SectionTitle title={snapshot.chartTitle} sub={snapshot.chartSub} />
          <div style={{ height: 150, display: "flex", gap: 28, alignItems: "flex-end", padding: "18px 30px 0" }}>
            {snapshot.bars.map((h, i) => (
              <div key={i} style={{ width: 38, height: h, background: "#315af4", borderRadius: "7px 7px 2px 2px" }} />
            ))}
          </div>
        </div>
        <div style={card({ height: 240 })}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, letterSpacing: "normal" }}>{snapshot.calcTitle}</h3>
          <div style={{ marginTop: 16, fontSize: 15, lineHeight: 2.05 }}>
            {snapshot.calcFormula.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
          <div style={{ marginTop: 4, paddingTop: 10, borderTop: "1px solid #e2e4ea", fontSize: 28, fontWeight: 800, color: "#159252" }}>
            {snapshot.calcResult}
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: "#777e8d" }}>
            {snapshot.calcMicro.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </div>
      </div>

      {/* per-video settlement table */}
      <div style={card({ marginTop: 16, height: 300 })}>
        <SectionTitle title={snapshot.tableTitle} sub={snapshot.tableSub} />
        <div style={{ display: "grid", gridTemplateColumns: TABLE_COLS, gap: 10, alignItems: "center", fontSize: 11, color: "#777d8b", padding: "14px 4px" }}>
          {snapshot.tableHead.map((h) => (
            <span key={h}>{h}</span>
          ))}
        </div>
        {snapshot.tableRows.map((r) => (
          <div
            key={r.video}
            style={{
              display: "grid",
              gridTemplateColumns: TABLE_COLS,
              gap: 10,
              alignItems: "center",
              fontSize: 12,
              borderTop: "1px solid #e5e7ec",
              padding: "18px 4px",
              color: r.muted ? "#777d8b" : undefined,
            }}
          >
            <b style={{ fontWeight: 700 }}>{r.video}</b>
            <span>{r.status}</span>
            <span>{r.totalViews}</span>
            <span>{r.eligibleViews}</span>
            <span>{r.countryCpm}</span>
            <b style={{ fontWeight: 700 }}>{r.amount}</b>
            <span>{r.sync}</span>
          </div>
        ))}
      </div>

      {snapshot.footerNote ? <div style={{ marginTop: 18, fontSize: 11, color: "#7b8190" }}>{snapshot.footerNote}</div> : null}
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
    <nav aria-label="파트너 상세 탭" role="tablist" style={{ display: "flex", gap: 42, marginTop: PARTNER_TAB_BAR_TOP_OFFSET, borderBottom: "1px solid #e1e4eb" }}>
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
              fontSize: 16,
              padding: "0 0 15px",
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
