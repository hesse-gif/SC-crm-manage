import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const USE_BUILT_SERVER = process.env.PLAYWRIGHT_USE_BUILT_SERVER === "1";
const BROWSER_CHANNEL = process.env.PLAYWRIGHT_BROWSER_CHANNEL;

const webServerCommand = USE_BUILT_SERVER
  ? `npm run start -- --port ${PORT}`
  : `node scripts/prepare-playwright-next.mjs && npm run dev:emu -- --port ${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(BROWSER_CHANNEL ? { channel: BROWSER_CHANNEL } : {}),
      },
    },
  ],
  webServer: {
    command: webServerCommand,
    url: BASE_URL,
    timeout: 240_000,
    reuseExistingServer: false,
    env: {
      NEXT_PUBLIC_USE_EMULATOR: "1",
      NEXT_PUBLIC_FLU_RUNTIME_ENV: "production",
      NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099",
      NEXT_PUBLIC_FUNCTIONS_EMULATOR_HOST: process.env.NEXT_PUBLIC_FUNCTIONS_EMULATOR_HOST ?? "127.0.0.1:5001",
      FIREBASE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099",
      FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080",
      FUNCTIONS_EMULATOR_HOST: process.env.FUNCTIONS_EMULATOR_HOST ?? "127.0.0.1:5001",
      GCLOUD_PROJECT: "demo-flu",
      GOOGLE_CLOUD_PROJECT: "demo-flu",
      FIREBASE_CONFIG: JSON.stringify({ projectId: "demo-flu" }),
    },
  },
});
