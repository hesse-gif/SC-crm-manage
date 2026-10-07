export const INTERNAL_SANDBOX_DOMAIN = process.env.FLU_INTERNAL_SANDBOX_DOMAIN?.trim().toLowerCase() || "@supercent.io";

export function envEmail(name: string): string {
  const value = process.env[name]?.trim().toLowerCase() ?? "";
  return value.includes("@") ? value : "";
}

export function envEmailList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.includes("@"));
}

export function generatedExampleEmail(seed: string): string {
  const local = seed
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "creator";
  return `${local}@example.test`;
}
