import { test, expect } from "@playwright/test";

test("projects sharing a folder retain separate workers and Orchestrators", async ({
  page,
}) => {
  const headers = { origin: "http://127.0.0.1:3105" };
  await page.goto("/");
  await expect(page.locator(".startup-intro")).toHaveCount(0);
  const key = await page.request.post("/api/providers/anthropic", {
    headers,
    data: { key: "sk-ant-project-fixture-1234" },
  });
  expect(key.ok()).toBe(true);
  async function makeProject(name: string) {
    await page.getByRole("button", { name: "Create project" }).click();
    await page.getByLabel("Project name").fill(name);
    await page.getByLabel("Project folder").fill("C:\\projects\\shared");
    await page
      .getByRole("button", { name: "Create project", exact: true })
      .last()
      .click();
    await expect(
      page.getByRole("dialog", { name: "Create project" }),
    ).toHaveCount(0);
    return await page.evaluate(() =>
      localStorage.getItem("vizor.activeProject"),
    );
  }
  const first = await makeProject("Feature one");
  expect(first).toBeTruthy();
  const config = {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    maxTokens: 512,
    temperature: 0.3,
  };
  const one = await page.request.patch("/api/orchestrator", {
    headers,
    data: { ...config, projectId: first },
  });
  expect(one.ok()).toBe(true);
  const worker = await page.request.post("/api/agents", {
    headers,
    data: {
      name: "First coder",
      engine: "claude-code",
      projectId: first,
      projectPath: "C:\\projects\\shared",
      provider: "anthropic",
      model: "claude-code",
      systemPrompt: "Implement code.",
      temperature: 0.2,
      maxTokens: 512,
      color: "blue",
      icon: "code",
    },
  });
  expect(worker.ok()).toBe(true);
  const second = await makeProject("Feature two");
  const two = await page.request.patch("/api/orchestrator", {
    headers,
    data: { ...config, projectId: second },
  });
  expect(two.ok()).toBe(true);
  expect((await one.json()).id).not.toBe((await two.json()).id);
  const stateTwo = await (
    await page.request.get(`/api/workspace?projectId=${second}`)
  ).json();
  expect(stateTwo.agents).toHaveLength(0);
  await page.getByRole("button", { name: "Feature one", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("vizor.activeProject")),
    )
    .toBe(first);
  await expect(page.getByRole("button", { name: /First coder/ })).toBeVisible();
  await page.reload();
  await expect(page.locator(".startup-intro")).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.getItem("vizor.activeProject")),
  ).toBe(first);
});
