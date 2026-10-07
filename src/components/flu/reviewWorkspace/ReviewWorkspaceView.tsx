"use client";

// Legacy review compatibility surface — 2026-09-05 검수 탭 적대 감사 확인.
// 운영 영상 검수 정본 UI 는 `src/app/(app)/flu/review/CanonicalVideoReviewPanel.tsx` 이고,
// 이 모듈의 큐/숫자는 `review_workspace_snapshots/current` 데모 시드
// (scripts/seed-flu-0538-demo.mjs)에서 온다. 실제 제출 원장(`scp_video_review_state`)이 아니다.
// 다타이틀·검수 로직 수정은 CanonicalVideoReviewPanel 과
// `functions/videoReviewStateCallables.ts` / `functions/videoReviewCriteria.ts` 에서 한다.
// 후속 삭제 PR 범위: 이 파일 + `src/lib/reviewWorkspaceData.ts` +
// `functions/reviewWorkspace.ts` + `getReviewWorkspaceSnapshot` 콜러블 등록 +
// review 스냅샷 시드. 이번 패스에서는 지우지 않는다.
// FLU-0538 pixel-clone surface 09 (/flu/review — human review workspace). Operator decision B: keep the
// app font (Pretendard Std), structural pixel-clone of the frozen mockup #review content region; global
// shell = allowed deviation; residual = app-font glyph floor (no foreign-font embed). Ported 1:1 from
// artifacts/ux-audit-20260719/07-view-settlement-scp-review-mockups.html (#review) via exact px inline
// styles, reusing surface-07/08 learnings (lineHeight 1.2 vs app base 1.5; letterSpacing:normal on h3;
// elements without an explicit font-size inherit the body default 16px). Data comes from
// getReviewWorkspaceSnapshot (demo-seeded today); present:false → the caller renders the real ReviewPage.
import type { CSSProperties, ReactNode } from "react";
import type {
  ReviewLine,
  ReviewTone,
  ReviewValueTone,
  ReviewWorkspaceSnapshot,
} from "@/lib/reviewWorkspaceData";

const PILL_TONE: Record<ReviewTone, CSSProperties> = {
  green: { background: "#e7f8ee", color: "#159252" },
  blue: { background: "#ebefff", color: "#315af4" },
  amber: { background: "#fff5d9", color: "#bf7700" },
  red: { background: "#ffe9e9", color: "#cf3d3d" },
  purple: { background: "#f1eaff", color: "#783cd7" },
};
const VALUE_TONE: Record<ReviewValueTone, string | undefined> = {
  green: "#159252",
  amber: "#bf7700",
  default: undefined,
};

function Pill({ tone, children }: { tone: ReviewTone; children: ReactNode }) {
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

function Note({ children, extra }: { children: ReactNode; extra?: CSSProperties }) {
  return (
    <div style={{ marginTop: 14, padding: 14, background: "#f4f6fa", borderRadius: 10, fontSize: 12, lineHeight: 1.55, color: "#626979", ...extra }}>
      {children}
    </div>
  );
}

function EvidenceLine({ line }: { line: ReviewLine }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr auto", fontSize: 12, padding: "13px 0", borderTop: "1px solid #e7e9ee" }}>
      <span>{line.label}</span>
      <b style={{ fontWeight: 700, color: VALUE_TONE[line.valueTone] }}>{line.value}</b>
    </div>
  );
}

const btn = (extra?: CSSProperties): CSSProperties => ({
  height: 40,
  marginTop: 18,
  borderRadius: 9,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 13,
  fontWeight: 700,
  background: "#315af4",
  color: "#fff",
  ...extra,
});

const ROOT: CSSProperties = {
  minHeight: "calc(100dvh - 64px)",
  background: "#f7f8fb",
  color: "#11131a",
  padding: "28px 32px",
  fontSize: 13,
  lineHeight: 1.2,
};

export function ReviewWorkspaceView({ snapshot }: { snapshot: ReviewWorkspaceSnapshot }) {
  if (!snapshot.present) {
    return (
      <div data-testid="review-workspace-view" style={ROOT}>
        <div style={{ fontSize: 29, fontWeight: 800 }}>사람 검수</div>
        <div style={{ ...card(), marginTop: 24, fontSize: 13, color: "#626979" }}>
          검수 워크스페이스 스냅샷이 아직 없습니다. 데모 시드(scripts/seed-flu-0538-demo.mjs) 적용 후 표시됩니다.
        </div>
      </div>
    );
  }

  return (
    <div data-testid="review-workspace-view" style={ROOT}>
      <div style={{ fontSize: 29, fontWeight: 800, display: "flex", alignItems: "center", gap: 12 }}>
        {snapshot.title}
        <Pill tone="purple">{snapshot.rolePill}</Pill>
      </div>
      <div style={{ marginTop: 8, fontSize: 13, color: "#727887" }}>{snapshot.subtitle}</div>

      {/* review-layout: queue (326px) | workspace (1fr) */}
      <div style={{ marginTop: 26, display: "grid", gridTemplateColumns: "326px 1fr", gap: 16 }}>
        {/* queue */}
        <div style={card({ height: 812 })}>
          <SectionTitle title={snapshot.queueTitle} sub={snapshot.queueSub} />
          {snapshot.queue.map((q) => (
            <div
              key={q.handle}
              style={{ height: 92, borderTop: "1px solid #e7e9ee", padding: 13, borderRadius: 10, background: q.active ? "#edf1ff" : undefined }}
            >
              <b style={{ fontSize: 12, fontWeight: 700 }}>{q.handle}</b>
              <span style={{ display: "block", fontSize: 11, color: "#777d8b", marginTop: 7 }}>{q.program}</span>
              <span style={{ display: "block", fontSize: 11, color: "#777d8b", marginTop: 7 }}>● {q.status}</span>
            </div>
          ))}
        </div>

        {/* workspace: 1.45fr | 1fr, decision spans 2 rows */}
        <div style={{ display: "grid", gridTemplateColumns: "1.45fr 1fr", gap: 16 }}>
          {/* media (r1c1) */}
          <div style={card({ height: 360 })}>
            <SectionTitle title={snapshot.mediaTitle} />
            <div style={{ height: 210, marginTop: 16, background: "#12151d", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 40 }}>▶</div>
            <h3 style={{ margin: 0, marginTop: 12, fontSize: 15, fontWeight: 700, letterSpacing: "normal" }}>{snapshot.videoName}</h3>
            <div style={{ marginTop: 8, fontSize: 11, color: "#777e8d" }}>{snapshot.videoMeta}</div>
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              {snapshot.mediaPills.map((p) => (
                <Pill key={p.label} tone={p.tone}>{p.label}</Pill>
              ))}
            </div>
          </div>

          {/* evidence (r1c2) */}
          <div style={card({ height: 360 })}>
            <SectionTitle title={snapshot.evidenceTitle} />
            {snapshot.evidenceLines.map((l) => (
              <EvidenceLine key={l.label} line={l} />
            ))}
            <Note>{snapshot.evidenceNote}</Note>
          </div>

          {/* detail (r2c1) */}
          <div style={card({ height: 214 })}>
            <SectionTitle title={snapshot.detailTitle} />
            {snapshot.detailLines.map((l) => (
              <EvidenceLine key={l.label} line={l} />
            ))}
            <div style={btn({ width: 200, background: "#ebefff", color: "#315af4" })}>{snapshot.detailButton}</div>
          </div>

          {/* decision (r2c2, spans 2 rows) */}
          <div style={card({ height: 434, gridRow: "span 2" })}>
            <SectionTitle title={snapshot.decisionTitle} sub={snapshot.decisionSub} />
            <Note>{snapshot.decisionNote}</Note>
            <div style={btn({ marginTop: 10, background: "#159252" })}>합격</div>
            <div style={btn({ marginTop: 10, background: "#e69518" })}>변경 요청</div>
            <div style={btn({ marginTop: 10, background: "#cf3d3d" })}>반려</div>
            <Note>
              <b style={{ fontWeight: 700 }}>{snapshot.mailNoteTitle}</b>
              {snapshot.mailNoteLines.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </Note>
            <div style={btn({ marginTop: 10, background: "#ebefff", color: "#315af4" })}>메일 미리보기</div>
            <div style={btn({ marginTop: 10 })}>결정 실행</div>
          </div>

          {/* audit (r3c1) */}
          <div style={card({ height: 204 })}>
            <SectionTitle title={snapshot.auditTitle} />
            <Note>
              {snapshot.auditNote.map((para, i) => (
                <div key={i} style={{ marginTop: i === 0 ? 0 : 12 }}>{para}</div>
              ))}
            </Note>
          </div>
        </div>
      </div>
    </div>
  );
}
