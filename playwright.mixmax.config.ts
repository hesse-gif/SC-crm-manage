import { defineConfig, devices } from "@playwright/test";

export const MIXMAX_E2E_PROJECT = process.env.MIXMAX_E2E_PROJECT ?? "demo-mixmax";
export const MIXMAX_E2E_DATABASE = process.env.MIXMAX_E2E_DATABASE ?? "mixmax";
export const MIXMAX_E2E_AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9499";
export const MIXMAX_E2E_FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST ?? "127.0.0.1:5401";
export const MIXMAX_E2E_FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8480";
export const MIXMAX_E2E_PORT = Number(process.env.MIXMAX_PLAYWRIGHT_PORT ?? process.env.PLAYWRIGHT_PORT ?? 3117);
export const MIXMAX_E2E_BASE_URL = process.env.MIXMAX_BASE_URL ?? `http://127.0.0.1:${MIXMAX_E2E_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "mixmax-independent.spec.ts",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: MIXMAX_E2E_BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {}),
      },
    },
  ],
  metadata: {
    env: {
      NEXT_PUBLIC_USE_EMULATOR: "1",
      NEXT_PUBLIC_MIXMAX_INDEPENDENT: "1",
      NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: MIXMAX_E2E_AUTH_HOST,
      NEXT_PUBLIC_FUNCTIONS_EMULATOR_HOST: MIXMAX_E2E_FUNCTIONS_HOST,
      NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: MIXMAX_E2E_FIRESTORE_HOST,
      GCLOUD_PROJECT: MIXMAX_E2E_PROJECT,
      GOOGLE_CLOUD_PROJECT: MIXMAX_E2E_PROJECT,
      FIREBASE_CONFIG: JSON.stringify({ projectId: MIXMAX_E2E_PROJECT }),
      MIXMAX_OWNER_EMAIL: process.env.MIXMAX_OWNER_EMAIL ?? "owner@mixmax.test",
    },
    ports: {
      auth: MIXMAX_E2E_AUTH_HOST,
      functions: MIXMAX_E2E_FUNCTIONS_HOST,
      firestore: MIXMAX_E2E_FIRESTORE_HOST,
      app: MIXMAX_E2E_PORT,
    },
    database: MIXMAX_E2E_DATABASE,
  },
});
