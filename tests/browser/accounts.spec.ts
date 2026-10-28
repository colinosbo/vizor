import { test, expect } from "@playwright/test";
const evidenceRoot = process.env.VIZOR_VERIFICATION_DIR ?? "verification";
test("registration, login, logout and private account workspace", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "New here? Create an account" })
    .click();
  await page.getByLabel("Email", { exact: true }).fill("browser@test.local");
  await page
    .getByLabel("Password", { exact: true })
    .fill("a-long-browser-password");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: /Your ideas/ })).toBeVisible();
  await page.screenshot({
    path: `${evidenceRoot}/account-workspace.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill("browser@test.local");
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".error-box")).toContainText("incorrect");
  await page
    .getByLabel("Password", { exact: true })
    .fill("a-long-browser-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Your ideas/ })).toBeVisible();
  const state = await (await page.request.get("/api/workspace")).json();
  expect(state.agents).toEqual([]);
  expect(state.provider.connected).toBe(false);
});
