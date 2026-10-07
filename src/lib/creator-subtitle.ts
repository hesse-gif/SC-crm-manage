export function prefixCreatorHandleToSubtitle(
  subtitle: string,
  handle: string | null | undefined,
): string {
  const trimmedHandle = handle?.trim() ?? "";
  if (!trimmedHandle) return subtitle;
  const displayHandle = trimmedHandle.startsWith("@") ? trimmedHandle : `@${trimmedHandle}`;
  return `${displayHandle} · ${subtitle}`;
}
