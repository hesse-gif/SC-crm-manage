export function isApprovedReviewStatus(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const status = value.trim().toLowerCase();
  return status === "pass" || status === "passed" || status === "approved";
}
