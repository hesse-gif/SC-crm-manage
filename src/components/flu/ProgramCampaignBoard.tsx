import Link from "next/link";
import { Avatar } from "@/components/ui/Avatar";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Chat, ChevronRight, Users } from "@/components/icons";
import { cn } from "@/lib/cn";
import type { ChatConversation } from "@/lib/chat-normalization";
import { programParticipantRowsForScope, type CanonicalParticipantDisplay } from "@/lib/program-participants";
import { campaignApplicationMetric, campaignRateLabel, isOperatorRegisteredCampaign } from "@/lib/program-campaign-metrics";
import { CANCELLED_CAMPAIGN_LABEL, isCancelledCampaignStatus } from "@/lib/campaign-status";
import { campaignFolders } from "@/lib/campaign-folders";
import { belongsToProgram, programIdBelongsToProgram, type Campaign, type Program, type ProgramApplication, type ProgramApplicationStatus } from "@/modules/programs";
import { responseSourceLabel, type ProgramFunnel, type ProgramFunnelPerson } from "@/modules/programs/funnel";

type ProgramCampaignBoardProps = {
  readonly program: Program;
  readonly campaigns: readonly Campaign[];
  readonly applications: readonly ProgramApplication[];
  readonly conversations: readonly ChatConversation[];
  readonly programFunnel?: ProgramFunnel;
  readonly selectedCampaignId: string | null;
  readonly onSelectCampaign: (campaignId: string) => void;
  readonly applicationProfileHref: (application: ProgramApplication) => string | null;
  readonly canonicalDisplayByIdentity?: ReadonlyMap<string, CanonicalParticipantDisplay>;
  readonly applicationStatusLabel: (status: ProgramApplicationStatus) => string;
  readonly applicationStatusTone: (status: ProgramApplicationStatus) => Tone;
  readonly hasMoreApplications: boolean;
  readonly loadingMoreApplications: boolean;
  readonly onLoadMoreApplications: () => void;
};

function campaignFunnelPeople(programFunnel: ProgramFunnel | undefined, campaignId: string): readonly ProgramFunnelPerson[] {
  return (programFunnel?.people ?? []).filter((person) => person.campaignIds.includes(campaignId));
}

function campaignFoldersForProgramFunnel(campaign: Campaign, programFunnel: ProgramFunnel | undefined) {
  const fallback = campaignFolders(campaign);
  const people = campaignFunnelPeople(programFunnel, campaign.id);
  if (people.length === 0) return fallback;
  // W32-FIX(39차 배포 전 교차검토 지적): 인원 목록은 recency 상위 200명 표본이라
  // (functions/scpProgramFunnelAggregate.ts:9 PEOPLE_SAMPLE_LIMIT=200) 총량의 정본이 아니다.
  // W32-D 의 정확 이메일 조인이 켜지면서 이 분기가 처음으로 실행되는데, 표본 파생값을 그대로 쓰면
  // 캠페인 counter 가 아는 전체 발송이 표본 크기까지 내려가 보인다(프로드 실측 320 → 198).
  // counter 와 표본의 큰 값을 쓴다 — 조인은 귀속을 끌어올리기만 하고 총량을 낮추지 않는다.
  const sampleSent = people.filter((person) => person.stages.sent).length;
  const sampleResponded = people.filter((person) => person.stages.responded).length;
  const sent = Math.max(fallback.sent, sampleSent);
  const responded = Math.max(fallback.responded, sampleResponded);
  return {
    sent,
    responded,
    noResponse: Math.max(0, sent - responded),
    dropped: fallback.dropped,
  };
}

// 비율 라벨 정본은 program-campaign-metrics 하나다 — 분모 0을 "0%"로 감추지 않는다.
const rateLabel = campaignRateLabel;

function mailedAtLabel(value: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return "발송일 미확인";
  return `발송 ${new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(millis))}`;
}

function contactLabel(participant: ProgramFunnelPerson): string {
  return participant.emailMasked || participant.handle || "이메일 미확인";
}

function mailedCreatorFacts(participant: ProgramFunnelPerson): string[] {
  return [
    contactLabel(participant),
    mailedAtLabel(participant.updatedAtIso),
    participant.followers ? `구독자 ${participant.followers.toLocaleString("ko-KR")}` : "",
    participant.region,
  ].filter(Boolean);
}

// W27-F3: a program can have people who responded but whose funnel record carries no campaignIds at
// all (never joined to a specific outreach) — every campaign's own folder count then reads "반응 0",
// which reads as "no one responded" when it may really mean "responded, but not attributed to this
// campaign." Surfacing that distinction is the whole fix; this does not attempt to guess which
// campaign an unattributed response belongs to.
function programHasUnattributedResponses(programFunnel: ProgramFunnel | undefined): boolean {
  return (programFunnel?.people ?? []).some((person) => person.stages.responded && person.campaignIds.length === 0);
}

// Symmetric to programHasUnattributedResponses above, for the applied stage: a person can have
// applied at the program level with no campaignIds at all (never joined to a specific outreach).
// Without this, a campaign whose scoped funnel sample happens to hold zero applied people reads
// as a confirmed "0 · 0%" even when the program has applicants that are simply unattributed.
function programHasUnattributedApplications(programFunnel: ProgramFunnel | undefined): boolean {
  return (programFunnel?.people ?? []).some((person) => person.stages.applied && person.campaignIds.length === 0);
}

function funnelStageLabel(stage: ProgramFunnelPerson["furthestStage"]): string {
  if (stage === "sent") return "발송";
  if (stage === "responded") return "반응";
  if (stage === "applied") return "신청";
  if (stage === "passed") return "합격";
  if (stage === "oneLink") return "OneLink";
  if (stage === "videoSubmitted") return "영상 제출";
  // #9 (2026-09-05 Aside 실측): 신청서 승인과 헷갈리지 않게 — 이 단계는 검수에서 승인된
  // 제출 영상을 뜻한다(programs/page.tsx KPI_LABEL.approved 와 같은 wording).
  if (stage === "approved") return "승인 영상";
  return "지급";
}

function campaignRowsForProgram(
  program: Program,
  campaigns: readonly Campaign[],
  applications: readonly ProgramApplication[],
  conversations: readonly ChatConversation[],
): Campaign[] {
  // U8: 소속 판정은 `@/modules/programs` 정본 하나만 쓴다. 예전에는 여기가 엄격 `===`,
  // /flu/campaigns 는 퍼지 판정이라 같은 캠페인이 두 진입점에서 다르게 분류됐다.
  const rows = campaigns.filter((campaign) => belongsToProgram(campaign, program, program.id));
  const seen = new Set(rows.map((campaign) => campaign.id));
  const campaignsById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const counts = new Map<string, number>();
  const titles = new Map<string, string>();

  // 실재하는 캠페인 문서가 이 프로그램 소속이 아니면 신청·대화 참조만으로 합성 행을 만들지
  // 않는다. 그게 프로그램 미지정 캠페인이 보드에 유령 행으로 뜨던 경로다(cp-mqz667bhgy5x).
  const skipSynthesis = (campaignId: string | null | undefined): boolean =>
    !campaignId || seen.has(campaignId) || campaignsById.has(campaignId);

  for (const application of applications) {
    if (skipSynthesis(application.campaignId)) continue;
    if (!programIdBelongsToProgram(application.programId, program, program.id)) continue;
    const campaignId = application.campaignId as string;
    counts.set(campaignId, (counts.get(campaignId) ?? 0) + 1);
    if (application.campaignTitle && !titles.has(campaignId)) titles.set(campaignId, application.campaignTitle);
  }
  for (const conversation of conversations) {
    if (skipSynthesis(conversation.campaignId)) continue;
    const programId = conversation.programId || campaignsById.get(conversation.campaignId || "")?.programId;
    if (!programIdBelongsToProgram(programId, program, program.id)) continue;
    const campaignId = conversation.campaignId as string;
    counts.set(campaignId, (counts.get(campaignId) ?? 0) + 1);
    if (conversation.campaignTitle && !titles.has(campaignId)) titles.set(campaignId, conversation.campaignTitle);
  }

  for (const [campaignId, count] of counts) {
    rows.push({
      id: campaignId,
      programId: program.id,
      name: titles.get(campaignId) || "캠페인",
      owner: program.owner,
      source: "검색",
      status: "발송중",
      priority: "보통",
      total: count,
      queued: 0,
      sent: 0,
      replied: 0,
      negotiating: 0,
      contracted: 0,
      live: 0,
      bounced: 0,
    });
    seen.add(campaignId);
  }

  return rows;
}

export function ProgramCampaignBoard({
  program,
  campaigns,
  applications,
  conversations,
  programFunnel,
  selectedCampaignId,
  onSelectCampaign,
  applicationProfileHref,
  canonicalDisplayByIdentity,
  applicationStatusLabel,
  applicationStatusTone,
  hasMoreApplications,
  loadingMoreApplications,
  onLoadMoreApplications,
}: ProgramCampaignBoardProps) {
  const programCampaigns = campaignRowsForProgram(program, campaigns, applications, conversations);
  const campaignIds = new Set(programCampaigns.map((campaign) => campaign.id));
  const campaignIdsByEmail = new Map<string, Set<string>>();
  for (const conversation of conversations) {
    const email = conversation.creatorEmail?.trim().toLowerCase();
    if (!email || !conversation.campaignId || !campaignIds.has(conversation.campaignId)) continue;
    const joinedIds = campaignIdsByEmail.get(email) ?? new Set<string>();
    joinedIds.add(conversation.campaignId);
    campaignIdsByEmail.set(email, joinedIds);
  }
  const joinedProgramFunnel = programFunnel ? {
    ...programFunnel,
    people: programFunnel.people.map((person) => {
      // C2 (2026-09-06 Aside 게이트 후속): 서버 canonical 집계 응답은 타입만 email: string 이지
      // 런타임 검증까지 강제하지는 않는다 — 결측 이메일 행에서 여기가 예외를 던지면(email이
      // undefined) 이 화면 전체가 렌더 예외로 죽는다(program 상세 렌더 중 크래시). 방어적으로
      // 빈 문자열 폴백만 두고 나머지 조인 로직은 그대로 둔다.
      const joinedIds = campaignIdsByEmail.get((person.email ?? "").trim().toLowerCase());
      return joinedIds ? { ...person, campaignIds: [...new Set([...person.campaignIds, ...joinedIds])] } : person;
    }),
  } : undefined;
  const selectedCampaign = programCampaigns.find((campaign) => campaign.id === selectedCampaignId) ?? null;
  const participantRows = programParticipantRowsForScope(program, selectedCampaign, programCampaigns, applications, conversations, {
    applicationProfileHref,
    canonicalDisplayByIdentity,
  });
  const funnelParticipantRows = (joinedProgramFunnel?.people ?? []).filter((person) => (
    selectedCampaign ? person.campaignIds.includes(selectedCampaign.id) : true
  ));
  const hasFunnelParticipants = funnelParticipantRows.length > 0;
  const visibleParticipantCount = hasFunnelParticipants ? funnelParticipantRows.length : participantRows.length;
  const unattributedResponses = programHasUnattributedResponses(joinedProgramFunnel);
  const unattributedApplications = programHasUnattributedApplications(joinedProgramFunnel);

  return (
    <div className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-ink-3">
          <span className="truncate text-ink-2">콜드메일</span>
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="truncate text-ink">{program.title}</span>
          <ChevronRight className="h-3.5 w-3.5" />
          <span>캠페인</span>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/flu/campaigns?programId=${encodeURIComponent(program.id)}&new=1`}
            className="inline-flex h-8 items-center justify-center rounded-md bg-accent px-3 text-[13px] font-semibold text-white hover:bg-accent/90"
          >
            새 캠페인
          </Link>
          <Link
            href={`/flu/campaigns?programId=${encodeURIComponent(program.id)}`}
            className="inline-flex h-8 items-center justify-center rounded-md border border-line bg-paper px-3 text-[13px] font-semibold text-ink hover:bg-fill"
          >
            전체 캠페인
          </Link>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <section className="min-w-0 overflow-hidden rounded-md border border-line bg-paper" aria-label="프로그램 캠페인">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-bold text-ink">
              <Chat className="h-4 w-4 text-accent" />
              캠페인
            </div>
            <span className="text-xs font-semibold text-ink-3">{programCampaigns.length}개</span>
          </div>
          <div className="divide-y divide-line">
            {programCampaigns.map((campaign) => {
              const funnelPeople = campaignFunnelPeople(joinedProgramFunnel, campaign.id);
              const active = selectedCampaign?.id === campaign.id;
              const folders = campaignFoldersForProgramFunnel(campaign, joinedProgramFunnel);
              const sentCount = folders.sent;
              const respondedCount = folders.responded;
              const operatorRegistered = isOperatorRegisteredCampaign(campaign);
              const applicationMetric = campaignApplicationMetric({
                program,
                campaign,
                applications,
                funnelPeople,
                sentCount,
                programHasUnattributedApplications: unattributedApplications,
              });
              return (
                <button
                  key={campaign.id}
                  type="button"
                  onClick={() => onSelectCampaign(campaign.id)}
                  className={cn("flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-fill/70", active && "bg-accent-soft")}
                >
                  <span className="mt-1 h-2 w-2 rounded-full bg-accent" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-ink">{campaign.name}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                      {/* 취소 상태는 Campaign["status"] 유니온 밖의 원문(cancelled 등)이라 그대로 두면
                          영문 원문이 운영자에게 노출된다. /flu/campaigns 와 같은 라벨을 쓴다. */}
                      {isCancelledCampaignStatus(campaign.status) ? (
                        <Badge tone="danger">{CANCELLED_CAMPAIGN_LABEL}</Badge>
                      ) : (
                        <Badge tone={campaign.status === "발송중" ? "ok" : "neutral"}>{campaign.status}</Badge>
                      )}
                      {campaign.source ? <Badge tone="neutral">{campaign.source}</Badge> : null}
                      {operatorRegistered ? <Badge tone="ai">운영자 등록</Badge> : null}
                    </span>
                    <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" aria-label="캠페인 누적 지표">
                      <span className="inline-flex items-baseline gap-1">
                        <span className="text-ink-4">발송</span>
                        <span className="font-semibold tabular-nums text-ink-2">{sentCount.toLocaleString("ko-KR")}</span>
                      </span>
                      <span className="inline-flex items-baseline gap-1">
                        <span className="text-ink-4">반응</span>
                        <span
                          className={cn(
                            "font-semibold tabular-nums",
                            respondedCount === 0 && unattributedResponses ? "text-warn" : respondedCount > 0 ? "text-accent" : "text-ink-2",
                          )}
                          title={respondedCount === 0 && unattributedResponses ? "이 프로그램에 캠페인 미귀속 반응이 있어 0이 반응 없음을 뜻하지 않을 수 있습니다." : undefined}
                        >
                          {respondedCount === 0 && unattributedResponses ? "귀속 안 됨" : `${respondedCount.toLocaleString("ko-KR")} · ${rateLabel(respondedCount, sentCount)}`}
                        </span>
                      </span>
                      <span className="inline-flex items-baseline gap-1">
                        <span className="text-ink-4">신청</span>
                        <span
                          className={cn("font-semibold tabular-nums", applicationMetric.unknown ? "text-warn" : "text-ink-2")}
                          title={applicationMetric.unknown ? "신청 단계 표본은 있지만 이 캠페인으로 귀속된 신청 원본이 아직 없어 총량을 계산하지 않습니다." : undefined}
                        >
                          {applicationMetric.label}
                        </span>
                      </span>
                    </span>
                  </span>
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-ink-4" />
                </button>
              );
            })}
            {programCampaigns.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-ink-4">연결된 캠페인이 없습니다.</div>
            ) : null}
          </div>
        </section>

        <section className="min-w-0 overflow-hidden rounded-md border border-line bg-paper" aria-label="발송 인플루언서">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-bold text-ink">
                <Users className="h-4 w-4 text-accent" />
                발송 인플루언서
              </div>
              <p className="mt-0.5 truncate text-xs text-ink-3">{selectedCampaign ? selectedCampaign.name : "프로그램 전체"}</p>
            </div>
            <span className="text-xs font-semibold text-ink-3">{visibleParticipantCount.toLocaleString("ko-KR")}명</span>
          </div>
          <div className="divide-y divide-line">
            {hasFunnelParticipants ? (
              funnelParticipantRows.map((participant) => (
                <div key={participant.key} className="flex items-center gap-3 px-4 py-3">
                  <Avatar label={participant.avatar} size={36} />
                  <div className="min-w-0 flex-1">
                    {participant.href ? (
                      <Link href={participant.href} className="block truncate text-sm font-semibold text-ink hover:text-accent hover:underline">
                        {participant.name}
                      </Link>
                    ) : (
                      <div className="truncate text-sm font-semibold text-ink">{participant.name}</div>
                    )}
                    <div className="truncate text-xs text-ink-3">{mailedCreatorFacts(participant).join(" · ")}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-ink-4">
                      {participant.handle ? <span>{participant.handle}</span> : null}
                      {participant.youtubeUrl ? (
                        <Link href={participant.youtubeUrl} className="font-semibold text-accent hover:underline">
                          채널 열기
                        </Link>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                    <Badge tone={participant.responseSource === "none" ? "neutral" : "accent"}>{responseSourceLabel(participant.responseSource)}</Badge>
                    <Badge tone="neutral">{funnelStageLabel(participant.furthestStage)}</Badge>
                  </div>
                </div>
              ))
            ) : (
              participantRows.map((participant) => (
                <div key={participant.key} className="flex items-center gap-3 px-4 py-3">
                  <Avatar label={participant.avatar} size={36} />
                  <div className="min-w-0 flex-1">
                    {participant.href ? (
                      <Link href={participant.href} className="block truncate text-sm font-semibold text-ink hover:text-accent hover:underline">
                        {participant.name}
                      </Link>
                    ) : (
                      <div className="truncate text-sm font-semibold text-ink">{participant.name}</div>
                    )}
                    <div className="truncate text-xs text-ink-3">{participant.meta || participant.sourceLabel}</div>
                  </div>
                  {participant.status ? (
                    <Badge tone={applicationStatusTone(participant.status)}>{applicationStatusLabel(participant.status)}</Badge>
                  ) : (
                    <Badge tone="neutral">{participant.sourceLabel}</Badge>
                  )}
                </div>
              ))
            )}
            {visibleParticipantCount === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-ink-4">{selectedCampaign ? "이 캠페인에 메일 발송 인플루언서가 없습니다." : "이 프로그램에 메일 발송 인플루언서가 없습니다."}</div>
            ) : null}
          </div>
        </section>
      </div>

      {hasMoreApplications ? (
        <div className="mt-3 flex justify-end">
          <Button variant="ghost" size="sm" onClick={onLoadMoreApplications} disabled={loadingMoreApplications}>
            {loadingMoreApplications ? "인플루언서 로딩 중" : "인플루언서 더 보기"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
