import { Badge, type Tone } from "./Badge";
import type { GuideStatus } from "@/lib/data";

const fallback = { tone: "neutral" as Tone, label: "가이드 미확인" };
const map: Record<GuideStatus, { tone: Tone; label: string }> = {
  within: { tone: "ok", label: "가이드 내" },
  near: { tone: "warn", label: "상한 근접" },
  over: { tone: "danger", label: "가이드 초과" },
};

export function GuideBadge({ status }: { status: GuideStatus | string | undefined }) {
  const m = status === "within" || status === "near" || status === "over" ? map[status] : fallback;
  return <Badge tone={m.tone}>{m.label}</Badge>;
}
