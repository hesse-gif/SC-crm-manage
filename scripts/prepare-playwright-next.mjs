import { rm } from "node:fs/promises";
import { join } from "node:path";

const nextDir = join(process.cwd(), ".next");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

for (let attempt = 1; attempt <= 5; attempt += 1) {
  try {
    await rm(nextDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
    process.exit(0);
  } catch (error) {
    if (attempt === 5) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[playwright] continuing after .next cleanup warning: ${message}`);
      process.exit(0);
    }
    await sleep(200 * attempt);
  }
}
