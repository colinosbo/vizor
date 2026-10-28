import "dotenv/config";
import { db } from "../src/lib/server/db";
import { defaultAgent } from "../src/lib/server/store";
if (process.env.SELF_HOST === "false")
  throw new Error("Demo seeding is available only in self-host mode.");
const user = await db.user.upsert({
  where: { id: "local-owner" },
  create: { id: "local-owner", email: "owner@vizor.local" },
  update: {},
});
for (const [id, name, icon, color, systemPrompt] of [
  [
    "demo-writer",
    "Writing partner",
    "pen",
    "amber",
    "Help write clear, thoughtful prose. Ask about the audience and intent when needed. Offer specific, concise edits.",
  ],
  [
    "demo-reviewer",
    "Code reviewer",
    "code",
    "mint",
    "Review code for correctness, security, and maintainability. Explain actionable findings with concrete examples. Do not claim you executed code.",
  ],
]) {
  await db.agent.upsert({
    where: { id },
    create: {
      id,
      userId: user.id,
      ...defaultAgent,
      name,
      icon,
      color,
      systemPrompt,
      demo: true,
      conversation: { create: {} },
    },
    update: {},
  });
}
console.log(
  "Two demo configurations are ready. No messages or keys were created.",
);
await db.$disconnect();
