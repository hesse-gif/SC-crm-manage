import { Badge } from "./Badge";
import { STAGES, type Stage } from "@/lib/data"

export function StageBadge({ stage }: { stage: Stage }) {
  const s = STAGES.find((x) => x.key === stage);
  if (!s) return null;
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}
