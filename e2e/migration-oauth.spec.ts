import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { loginAsAdmin } from "./helpers/emulator";

type CallableBody = Record<string, unknown>;

type OAuthStubOptions = {
  begin?: CallableBody;
  onStatusPayload?: (payload: Record<string, unknown>) => void;
};

const SAFE_GOOGLE_CONSENT_URL = "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic-client&scope=https%3A%2F%2Fmail.google.com%2F&response_type=code";
const UNSAFE_CONSENT_URL = "https://evil.example.test/oauth";

const syntheticAccount = {
  accountId: "self-oauth",
  label: "Admin Workspace Mail",
  mailbox: "admin@supercent.io",
  kind: "workspace_oauth",
  status: "active",
  ownerEmail: "admin@supercent.io",
  orgIds: ["T999"],
  smtp: {},
  imap: {},
  secretRefKind: "oauth",
  createdBy: "e2e",
  createdAt: "2026-10-07T00:00:00.000Z",
  updatedBy: "e2e",
  updatedAt: "2026-10-07T00:00:00.000Z",
};

const routing = {
  defaultAccountId: "self-oauth",
  byOrgId: { T999: "self-oauth" },
  personalMailAllowedOrgIds: ["T999"],
  chatPersonalViewDefaultOrgIds: [],
  scpAllowedOrgIds: null,
  policyVersion: "e2e",
  updatedBy: "e2e",
  updatedAt: "2026-10-07T00:00:00.000Z",
};

function callableResult(body: CallableBody) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ result: body }),
  };
}

function requestPayload(route: Route): Record<string, unknown> {
  const raw = route.request().postDataJSON() as { data?: Record<string, unknown> } | Record<string, unknown> | null;
  return (raw && "data" in raw && raw.data && typeof raw.data === "object") ? raw.data as Record<string, unknown> : {};
}

async function stubGoogleConsent(context: BrowserContext) {
  await context.route("https://accounts.google.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Google consent stub</title><main>synthetic Google consent</main>",
    });
  });
}

async function stubOAuthCompanionCallables(page: Page, options: OAuthStubOptions = {}) {
  await page.route(/beginMailOAuth/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill(callableResult(options.begin ?? {
      ok: true,
      accountId: "self-oauth",
      consentUrl: SAFE_GOOGLE_CONSENT_URL,
      expiresAtIso: "2026-10-07T01:00:00.000Z",
    }));
  });

  await page.route(/getMailOAuthStatus/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    options.onStatusPayload?.(requestPayload(route));
    await route.fulfill(callableResult({
      ok: true,
      accountId: "self-oauth",
      linked: false,
      subjectEmail: "admin@supercent.io",
      scopes: [],
      linkedAt: null,
      expiresAt: null,
      status: null,
      connectionCheck: requestPayload(route).verifyConnection ? {
        status: "reauth_required",
        checkedAt: "2026-10-07T00:00:00.000Z",
        reason: "e2e_pending_consent",
      } : undefined,
    }));
  });

  await page.route(/getMyOrgContext/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill(callableResult({
      ok: true,
      orgId: "T999",
      orgName: "Migration OAuth Org",
      accountLabel: syntheticAccount.label,
      accountMailbox: syntheticAccount.mailbox,
      orgAccountAssigned: true,
      scpAccessGranted: true,
      linked: false,
      mailConnectNoticeDismissed: false,
      navPreset: null,
      partnerDataSource: "scp",
      accessibleAccounts: [syntheticAccount],
      personalAccount: syntheticAccount,
      orgAccount: syntheticAccount,
      usableSenders: [syntheticAccount],
      defaultSenderId: "self-oauth",
      senderBlockedReason: null,
      orgResolutionStatus: "resolved",
      personalMailConnectAllowed: true,
    }));
  });

  await page.route(/listMailAccounts/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill(callableResult({ ok: true, accounts: [syntheticAccount], routing }));
  });
}

async function openIntegrations(page: Page) {
  await loginAsAdmin(page, "/admin/integrations");
  await expect(page.getByTestId("my-mail-connection")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("my-mail-connection").getByRole("button", { name: /Google 연결|다시 연결/ })).toBeEnabled({ timeout: 20_000 });
}

test.describe("migration OAuth companion UX", () => {
  test("safe Google consent opens a companion window without navigating the main app", async ({ context, page }) => {
    await stubGoogleConsent(context);
    const statusPayloads: Record<string, unknown>[] = [];
    await stubOAuthCompanionCallables(page, {
      onStatusPayload: (payload) => statusPayloads.push(payload),
    });
    await openIntegrations(page);

    const mainUrl = page.url();
    const popupPromise = page.waitForEvent("popup");
    await page.getByTestId("my-mail-connection").getByRole("button", { name: /Google 연결|다시 연결/ }).click();
    const popup = await popupPromise;

    await expect(page).toHaveURL(mainUrl);
    await expect(page.getByTestId("my-mail-connection-notice")).toContainText("supercent.io Google Workspace");
    await expect.poll(() => popup.url(), { timeout: 10_000 }).toContain("https://accounts.google.com/");
    await expect(popup.locator("main")).toContainText("synthetic Google consent");
    statusPayloads.length = 0;
    await popup.close();
    await expect.poll(
      () => statusPayloads.some((payload) => payload.self === true && payload.verifyConnection === true),
      { timeout: 10_000 },
    ).toBe(true);
  });

  test("unsafe consent URL is blocked and the main app stays on integrations", async ({ page }) => {
    await stubOAuthCompanionCallables(page, {
      begin: { ok: true, accountId: "self-oauth", consentUrl: UNSAFE_CONSENT_URL },
    });
    await openIntegrations(page);

    const mainUrl = page.url();
    const popupPromise = page.waitForEvent("popup");
    await page.getByTestId("my-mail-connection").getByRole("button", { name: /Google 연결|다시 연결/ }).click();
    const popup = await popupPromise;

    await expect(page).toHaveURL(mainUrl);
    await expect(page.getByTestId("my-mail-connection-notice")).toContainText("accounts.google.com");
    await expect.poll(() => popup.isClosed(), { timeout: 10_000 }).toBe(true);
  });

  test("popup-blocked path exposes a noopener fallback and refreshes status on return", async ({ context, page }) => {
    await stubGoogleConsent(context);
    await page.addInitScript(() => {
      window.open = () => null;
    });
    const statusPayloads: Record<string, unknown>[] = [];
    await stubOAuthCompanionCallables(page, {
      onStatusPayload: (payload) => statusPayloads.push(payload),
    });
    await openIntegrations(page);
    statusPayloads.length = 0;

    await page.getByTestId("my-mail-connection").getByRole("button", { name: /Google 연결|다시 연결/ }).click();

    const fallback = page.getByTestId("my-mail-connection").getByRole("link", { name: "Google 동의 열기" });
    await expect(fallback).toBeVisible({ timeout: 10_000 });
    await expect(fallback).toHaveAttribute("href", SAFE_GOOGLE_CONSENT_URL);
    await expect(fallback).toHaveAttribute("target", "_blank");
    await expect(fallback).toHaveAttribute("rel", /noopener/);
    await expect(page.getByTestId("my-mail-connection-notice")).toContainText("팝업이 차단되었습니다");

    await fallback.click();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));

    await expect.poll(
      () => statusPayloads.some((payload) => payload.self === true && payload.verifyConnection === true),
      { timeout: 10_000 },
    ).toBe(true);
  });
});
