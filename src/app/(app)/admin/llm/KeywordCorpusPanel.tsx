"use client";

// W90 [write-only 해소]: 키워드 코퍼스 읽기 전용 패널.
//
// 종전에는 코퍼스가 캠페인 문서 안 map 으로만 존재해 **아무 화면에도 뜨지 않았다.** 자동 편입을
// 켜려면 헤세가 "무엇이 왜 들어왔고 무엇이 왜 죽었는지"를 매일 볼 수 있어야 한다는 게 이번 조건이다.
//
// 서버가 정제한 행만 받는다(getCampaignKeywordCorpus). 프롬프트·응답 원문은 애초에 저장되지
// 않으므로 여기로 나올 것도 없고, 크리틱/퇴역 사유는 서버에서 이미 길이 절단된 짧은 문자열이다.

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Card, CardHeader } from "@/components/ui/Card";
import { getCampaignKeywordCorpus, type KeywordCorpusRejectionView, type KeywordCorpusRowView } from "@/lib/data";
import { publicCallableErrorMessage, useLive, useLiveCampaigns } from "@/lib/live";

const SOURCE_LABEL: Record<KeywordCorpusRowView["source"], string> = {
  seed: "운영자 시드",
  mined: "n-gram 마이닝",
  llm: "LLM 제안",
};

function sourceTone(source: KeywordCorpusRowView["source"]): "neutral" | "info" | "ai" {
  if (source === "llm") return "ai";
  if (source === "mined") return "info";
  return "neutral";
}

type CampaignOption = { id?: string; name?: string; title?: string };

export function KeywordCorpusPanel() {
  // /admin/llm 은 캠페인 컨텍스트가 없는 페이지라 패널이 스스로 고른다.
  //
  // W90b: useLiveCollection 은 fail-closed 라 **소유 화면이 키를 로드해줘야만** 데이터를 준다 —
  // 이 페이지는 campaigns 키를 안 부르므로 패널이 직접 부른다(useLiveScpLifecycleProfiles 선례).
  // 이게 없으면 콤보박스가 영원히 "캠페인 없음"이다(72차 배포 후 프로드 실측).
  const { loadKeys } = useLive();
  useEffect(() => {
    void loadKeys(["campaigns"], true);
  }, [loadKeys]);
  const campaigns = useLiveCampaigns<CampaignOption>([]);
  const [campaignId, setCampaignId] = useState("");
  useEffect(() => {
    if (campaignId) return;
    const first = campaigns.find((entry) => typeof entry.id === "string" && entry.id);
    if (first?.id) setCampaignId(first.id);
  }, [campaigns, campaignId]);
  const [rows, setRows] = useState<KeywordCorpusRowView[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [updatedAtIso, setUpdatedAtIso] = useState("");
  // W90-R3: 거부 이력은 **우주에 없는 term** 이라 rows 와 별도 축이다.
  const [rejections, setRejections] = useState<KeywordCorpusRejectionView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!campaignId) return;
    setLoading(true);
    setError(null);
    try {
      const envelope = await getCampaignKeywordCorpus({ campaignId });
      setRows(envelope.rows ?? []);
      setRejections(envelope.rejections ?? []);
      setActiveCount(envelope.activeCount ?? 0);
      setUpdatedAtIso(envelope.updatedAtIso ?? "");
    } catch (caught) {
      setError(publicCallableErrorMessage(caught, "키워드 코퍼스를 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card className="mt-6">
      <CardHeader
        title="키워드 코퍼스"
        desc="검색 키워드의 출처·수율·크리틱 판정. 이메일 수율 0이 연속되면 자동 퇴역합니다."
      />
      <div className="px-5 pb-3">
        <select
          value={campaignId}
          onChange={(event) => setCampaignId(event.target.value)}
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink"
        >
          {campaigns.length === 0 ? <option value="">캠페인 없음</option> : null}
          {campaigns.map((entry) => (
            <option key={entry.id ?? ""} value={entry.id ?? ""}>{entry.title ?? entry.name ?? entry.id}</option>
          ))}
        </select>
      </div>
      <div className="px-5 pb-2 text-xs text-ink-4">
        {loading ? "불러오는 중…" : `활성 ${activeCount}개 · 전체 ${rows.length}개${updatedAtIso ? ` · 갱신 ${updatedAtIso.slice(0, 16).replace("T", " ")}` : ""}`}
      </div>
      {error ? <div className="px-5 pb-4 text-xs text-danger">{error}</div> : null}
      {!error && rows.length === 0 && !loading ? (
        <div className="px-5 pb-5 text-xs text-ink-4">이 캠페인에는 아직 코퍼스 기록이 없습니다.</div>
      ) : null}
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-4">
              <tr>
                <th className="px-5 py-2">키워드</th>
                <th className="px-5 py-2">출처</th>
                <th className="px-5 py-2">상태</th>
                <th className="px-5 py-2 text-right">신규 채널</th>
                <th className="px-5 py-2 text-right">이메일 수율</th>
                <th className="px-5 py-2">판정 / 퇴역 사유</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.term} className="border-t border-line">
                  <td className="px-5 py-3 font-medium text-ink">{row.term}</td>
                  <td className="px-5 py-3">
                    <Badge tone={sourceTone(row.source)}>{SOURCE_LABEL[row.source]}</Badge>
                  </td>
                  <td className="px-5 py-3">
                    <Badge tone={row.state === "active" ? "ok" : "neutral"}>
                      {row.state === "active" ? "활성" : "퇴역"}
                    </Badge>
                  </td>
                  <td className="px-5 py-3 text-right text-ink-2">{row.newUniqueTotal.toLocaleString()}</td>
                  <td className="px-5 py-3 text-right text-ink-2">
                    {row.emailResolvedTotal.toLocaleString()}
                    {row.emailZeroStreak > 0 ? (
                      <span className="ml-1 text-xs text-warn">연속 0 × {row.emailZeroStreak}</span>
                    ) : null}
                  </td>
                  <td className="px-5 py-3 text-xs text-ink-3">
                    {row.retiredReason ? `퇴역: ${row.retiredReason}` : row.criticReason || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {rejections.length > 0 ? (
        <div className="border-t border-line px-5 py-4">
          <div className="text-xs font-medium text-ink-2">크리틱이 거부한 후보 (최근 {rejections.length}건)</div>
          <div className="mt-1 text-[11px] text-ink-4">
            우주에 편입되지 않아 위 표에는 없습니다. 무엇이 왜 걸러졌는지가 자동 편입을 계속 켜둘지 판단하는 근거입니다.
          </div>
          <ul className="mt-2 space-y-1">
            {rejections.map((entry) => (
              <li key={`${entry.term}:${entry.rejectedAtIso}`} className="text-xs text-ink-3">
                <span className="font-medium text-ink-2">{entry.term}</span>
                <span className="mx-1 text-ink-4">—</span>
                {entry.reason || "사유 없음"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
