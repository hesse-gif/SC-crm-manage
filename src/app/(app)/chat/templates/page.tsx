"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { externalFluHref } from "@/lib/flu-external-link";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Card, CardHeader } from "@/components/ui/Card";
import { ListRow } from "@/components/ui/ListRow";
import { Sparkles } from "@/components/icons";
import { FeedbackHover } from "@/components/ui/FeedbackHover";
import { TEMPLATE_STAGE,
upsertTemplate,
type MessageTemplate, } from "@/lib/data"
import { requestDataRefresh, useLiveTemplates } from "@/lib/live";

// {{var}} 토큰을 파싱해 일반 텍스트와 변수 칩으로 분리 렌더링.
function BodyWithVars({ body }: { body: string }) {
  const parts = body.split(/(\{\{\w+\}\})/);
  return (
    <>
      {parts.map((part, i) => {
        const match = part.match(/^\{\{(\w+)\}\}$/);
        if (match) {
          return (
            <span
              key={i}
              className="inline-block rounded bg-accent-soft px-1 font-medium text-accent"
            >
              {part}
            </span>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

export default function TemplatesPage() {
  const liveTemplates = useLiveTemplates<MessageTemplate>([]);
  const templates = liveTemplates;
  const [selectedId, setSelectedId] = useState("");
  const [aiToggle, setAiToggle] = useState(false);
  const [personalization, setPersonalization] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const selected: MessageTemplate | undefined =
    templates.find((t) => t.id === selectedId) ?? templates[0];

  useEffect(() => {
    if (templates.length > 0 && !templates.some((item) => item.id === selectedId)) {
      setSelectedId(templates[0].id);
    }
  }, [selectedId, templates]);

  useEffect(() => {
    if (!selected) return;
    setAiToggle(selected.aiManaged);
    setPersonalization(Object.fromEntries((selected.vars ?? []).map((key) => [
      key,
      selected.personalizationHints?.[key] ?? "",
    ])));
  }, [selected]);

  const previewBody = useMemo(() => {
    if (!selected) return "";
    return selected.body.replace(/\{\{(\w+)\}\}/g, (_, key: string) => personalization[key] || `{{${key}}}`);
  }, [personalization, selected]);

  async function saveAiManaged(next: boolean) {
    if (!selected || saving) return;
    setSaving(true);
    setError("");
    setAiToggle(next);
    try {
      await upsertTemplate({ ...selected, aiManaged: next });
      requestDataRefresh();
    } catch (caught) {
      setAiToggle(selected.aiManaged);
      setError(caught instanceof Error ? caught.message : "템플릿 저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  if (!selected) {
    return (
      <div className="mx-auto max-w-content px-6 py-7">
        <PageHeader
          title="메시지 템플릿"
          desc="컨택·협의·계약·검수 단계별 재사용 메시지"
          action={
            <Link href={externalFluHref("/flu/programs")} className="inline-flex min-h-10 items-center rounded-md border border-line bg-paper px-3 text-sm font-semibold text-ink-2 hover:bg-fill">
              프로그램 메일 설정
            </Link>
          }
        />
        <p className="mt-8 text-sm text-ink-3">등록된 템플릿이 없습니다.</p>
      </div>
    );
  }

  const stageMeta = TEMPLATE_STAGE[selected.stage];

  return (
    <div className="mx-auto max-w-content px-6 py-7">
      <PageHeader
        title="메시지 템플릿"
        desc="컨택·협의·계약·검수 단계별 재사용 메시지"
        action={
          <Link href={externalFluHref("/flu/programs")} className="inline-flex min-h-10 items-center rounded-md border border-line bg-paper px-3 text-sm font-semibold text-ink-2 hover:bg-fill">
            프로그램 메일 설정
          </Link>
        }
      />

      <div className="grid gap-4 lg:grid-cols-5">
        {/* LEFT — 템플릿 목록 */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader
              title="템플릿 목록"
              desc="AI 자동·사람 재사용 메시지"
              action={
                <span className="text-xs text-ink-3">{templates.length}개</span>
              }
            />
            <div>
              {templates.map((t) => {
                const sm = TEMPLATE_STAGE[t.stage];
                const active = t.id === selectedId;
                return (
                  <ListRow
                    key={t.id}
                    onClick={() => setSelectedId(t.id)}
                    className={
                      active ? "bg-accent-soft hover:bg-accent-soft" : undefined
                    }
                    title={<span className="truncate">{t.title}</span>}
                    subtitle={`${sm.label} · ${t.channel}`}
                    meta={
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex items-center gap-1">
                          {t.aiManaged && (
                            <Badge tone="ai">AI</Badge>
                          )}
                          <Badge tone={sm.tone}>{sm.label}</Badge>
                        </div>
                        <span className="text-ink-4">{t.usage}회</span>
                      </div>
                    }
                  />
                );
              })}
            </div>
          </Card>
        </div>

        {/* RIGHT — 선택 템플릿 상세 */}
        <div className="lg:col-span-3 space-y-4">
          {/* 헤더 */}
          <Card>
            <div className="flex items-start justify-between gap-3 px-5 py-4">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-bold text-ink">
                  {selected.title}
                </h2>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <Badge tone={stageMeta.tone}>{stageMeta.label}</Badge>
                  <span className="text-xs text-ink-3">{selected.channel}</span>
                  {aiToggle && (
                    <Badge tone="ai">
                      <Sparkles className="h-3 w-3" />
                      AI 자동 사용
                    </Badge>
                  )}
                </div>
              </div>
              <span className="shrink-0 text-xs text-ink-4">{selected.usage}회 사용</span>
            </div>
          </Card>

          {/* 본문 미리보기 */}
          <Card>
            <CardHeader title="메시지 본문" desc="{{변수}}는 발송 시 자동 치환됩니다" />
            <div className="px-5 py-4">
              {aiToggle ? (
                <FeedbackHover
                  target="mail"
                  pipelineDomain="mail"
                  artifactRef={`templates/${selected.id}`}
                  excerpt={selected.body}
                  globalScope="global"
                  locale="und"
                >
                  <div className="rounded-md bg-fill p-4 text-sm leading-relaxed text-ink">
                    <BodyWithVars body={selected.body} />
                  </div>
                </FeedbackHover>
              ) : (
                <div className="rounded-md bg-fill p-4 text-sm leading-relaxed text-ink">
                  <BodyWithVars body={selected.body} />
                </div>
              )}
            </div>

            {/* 변수 칩 목록 */}
              {(selected.vars ?? []).length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-5 py-3">
                <span className="text-xs text-ink-3 mr-1">변수</span>
                {(selected.vars ?? []).map((v) => (
                  <span
                    key={v}
                    className="rounded bg-fill px-2 py-0.5 text-xs font-medium text-ink-2 border border-line"
                  >
                    {`{{${v}}}`}
                  </span>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader
              title="개인화 미리보기"
              desc={selected.fixed ? "Infly 고정 폼 템플릿은 운영 기본값으로 보호됩니다" : "변수값을 입력하면 발송 전 문장으로 치환됩니다"}
              action={selected.fixed ? <Badge tone="ok">고정</Badge> : undefined}
            />
            <div className="grid gap-3 px-5 py-4 md:grid-cols-2">
              <div className="space-y-2">
                {(selected.vars ?? []).map((key) => (
                  <label key={key} className="block">
                    <span className="mb-1 block text-xs font-medium text-ink-3">{`{{${key}}}`}</span>
                    <input
                      value={personalization[key] ?? ""}
                      onChange={(event) => setPersonalization((current) => ({ ...current, [key]: event.target.value }))}
                      className="h-9 w-full rounded-md border border-line bg-paper px-3 text-sm text-ink outline-none placeholder:text-ink-4 focus:ring-2 focus:ring-accent/20"
                      placeholder={selected.personalizationHints?.[key] ?? key}
                    />
                  </label>
                ))}
              </div>
              <div className="whitespace-pre-wrap rounded-md bg-fill p-4 text-sm leading-relaxed text-ink">
                {previewBody}
              </div>
            </div>
          </Card>

          {/* 컨트롤 */}
          <Card>
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              {/* AI 자동 사용 토글 */}
              <button
                type="button"
                onClick={() => saveAiManaged(!aiToggle)}
                disabled={saving}
                className="group flex min-h-10 items-center gap-2.5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span
                  className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${
                    aiToggle ? "bg-ai" : "bg-fill border border-line"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                      aiToggle ? "translate-x-4" : "translate-x-0.5"
                    }`}
                  />
                </span>
                <span className="text-sm font-medium text-ink-2 group-hover:text-ink transition-colors">
                  AI 자동 사용
                </span>
                {aiToggle && (
                  <Badge tone="ai">
                    <Sparkles className="h-3 w-3" />켜짐
                  </Badge>
                )}
              </button>

              <div className="flex min-w-0 flex-col items-end gap-1.5 text-right">
                <p className="text-xs leading-relaxed text-ink-3">
                  본문·신규 템플릿은 프로그램별 메일 설정에서 관리합니다.
                </p>
                <Link
                  href="/chat"
                  className="inline-flex min-h-10 items-center rounded-md bg-accent px-3 text-[13px] font-semibold text-white transition-[background-color,scale] hover:bg-accent/90 active:scale-[0.96]"
                >
                  대화에서 메시지 작성
                </Link>
              </div>
            </div>
            {error && <div className="border-t border-line px-5 py-3 text-xs font-medium text-danger">{error}</div>}
          </Card>
        </div>
      </div>
    </div>
  );
}
