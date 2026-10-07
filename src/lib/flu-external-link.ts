const DEFAULT_FLU_APP_URL = "https://influchat-77db6.web.app";

export function externalFluHref(path: string): string {
  const configuredBase = process.env.NEXT_PUBLIC_FLU_APP_URL?.trim() || DEFAULT_FLU_APP_URL;
  try {
    return new URL(path, configuredBase).toString();
  } catch {
    return new URL(path, DEFAULT_FLU_APP_URL).toString();
  }
}
