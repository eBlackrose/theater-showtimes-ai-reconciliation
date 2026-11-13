import { expect, test, type Page } from "@playwright/test";

/**
 * The reviewer walkthrough in a real browser, against a running app with a real model:
 *   E2E_BASE_URL=http://localhost:3000 npx playwright test
 * It resets the demo data before and after, so only point it at a demo deployment.
 */
const AVERY = "user-admin-avery";
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `test-results/shots/${name}.png`, fullPage: true });

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

test.beforeAll(async ({ request }) => {
  const reset = await request.post("/api/admin/reset-demo", { headers: { "x-user-id": AVERY } });
  expect(reset.ok()).toBe(true);
});
test.afterAll(async ({ request }) => {
  await request.post("/api/admin/reset-demo", { headers: { "x-user-id": AVERY } });
});

async function signIn(page: Page, user: string, theater?: string) {
  await page.goto("/");
  await page.locator("select").first().selectOption(user);
  if (theater) {
    await page.getByRole("combobox").filter({ hasText: "All accessible theaters" }).selectOption(theater);
  }
}

async function runSample(page: Page, file: string) {
  await page.getByRole("button", { name: /Try a sample/ }).click();
  await page.getByText(file, { exact: false }).first().click();
  const review = page.getByRole("button", { name: "Review proposal" });
  await expect(review).toBeEnabled({ timeout: 180_000 });
}

test("admin: upload new-drop.csv, watch the agent, review, apply; second upload needs no AI", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await signIn(page, AVERY, "theater-downtown");
  await expect(page.getByText("Spider-Man: Homecoming")).toBeVisible();
  await expect(page.getByText(/AI: claude/)).toBeVisible();
  await shot(page, "01-console");

  await runSample(page, "new-drop.csv");
  await expect(page.getByText(/Decided: "Aud 1" is Auditorium 1/)).toBeVisible();
  await shot(page, "02-analysis");
  await page.getByRole("button", { name: "Review proposal" }).click();
  await expect(page.getByText("Kung Fu Panda 4").first()).toBeVisible();
  await shot(page, "03-review");
  await page.getByRole("button", { name: /^Apply 1 change$/ }).click();
  await expect(page.getByText(/applied/i).first()).toBeVisible({ timeout: 60_000 });
  await shot(page, "04-applied");

  await page.keyboard.press("Escape");
  await page.reload();
  await page.locator("select").first().selectOption(AVERY);
  await page.getByRole("combobox").filter({ hasText: "All accessible theaters" }).selectOption("theater-downtown");
  await expect(page.getByRole("cell", { name: "Auditorium 5" }).first()).toBeVisible();

  await runSample(page, "new-drop.csv");
  await expect(page.getByText(/Nothing needed AI/).first()).toBeVisible();
  await shot(page, "05-second-upload");
  expect(errors).toEqual([]);
});

test("admin: ai-messy-drop.csv shows AI resolutions and a reschedule", async ({ page }) => {
  await signIn(page, AVERY, "theater-downtown");
  await runSample(page, "ai-messy-drop.csv");
  await shot(page, "06-messy-analysis");
  await page.getByRole("button", { name: "Review proposal" }).click();
  await expect(page.getByText("Challengers").first()).toBeVisible();
  await shot(page, "07-messy-review");
});

test("admin: invalid file lists every row error", async ({ page }) => {
  await signIn(page, AVERY, "theater-downtown");
  await page.getByRole("button", { name: /Try a sample/ }).click();
  await page.getByText("invalid-drop.csv", { exact: false }).first().click();
  await expect(page.getByText(/15\/03\/2025 6pm/)).toBeVisible({ timeout: 30_000 });
  await shot(page, "08-invalid");
});

test("history lists imports; viewer is read-only; a user without theaters sees an empty state", async ({ page }) => {
  await signIn(page, AVERY);
  await page.getByRole("button", { name: "Import history" }).click();
  await expect(page.getByText("new-drop.csv").first()).toBeVisible();
  await shot(page, "09-history");
  await page.keyboard.press("Escape");

  await page.locator("select").first().selectOption("user-viewer-riley");
  await expect(page.getByText(/read-only/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /Try a sample/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Clear Schedule" })).toHaveCount(0);
  await shot(page, "10-viewer");

  await page.locator("select").first().selectOption("user-viewer-jordan");
  await expect(page.getByText(/does not belong to any theaters/)).toBeVisible();
});
