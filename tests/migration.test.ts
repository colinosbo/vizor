import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { encryptKey, decryptKey } from "../src/lib/server/crypto";
it("upgrades a populated stage-one database without losing keys, accounts or history", () => {
  const sqlite = new Database(":memory:");
  try {
    const migrations = readdirSync("prisma/migrations")
      .filter((name) => /^\d/.test(name))
      .sort();
    sqlite.exec(
      readFileSync(`prisma/migrations/${migrations[0]}/migration.sql`, "utf8"),
    );
    const encrypted = encryptKey(
      "sk-ant-fixture-migration",
      "owner",
      "anthropic",
    );
    sqlite
      .prepare("INSERT INTO User (id,email,passwordHash) VALUES (?,?,?)")
      .run("owner", "migration@test.local", "existing-hash");
    sqlite
      .prepare(
        "INSERT INTO Credential (id,userId,provider,encrypted,last4,updatedAt) VALUES (?,?,?,?,?,?)",
      )
      .run(
        "key",
        "owner",
        "anthropic",
        encrypted,
        "tion",
        new Date().toISOString(),
      );
    sqlite
      .prepare(
        "INSERT INTO Agent (id,userId,name,model,systemPrompt) VALUES (?,?,?,?,?)",
      )
      .run(
        "agent",
        "owner",
        "Existing writer",
        "claude-sonnet-4-6",
        "Keep this role",
      );
    sqlite
      .prepare("INSERT INTO Conversation (id,agentId) VALUES (?,?)")
      .run("conversation", "agent");
    sqlite
      .prepare(
        "INSERT INTO Message (id,conversationId,position,role,text) VALUES (?,?,?,?,?)",
      )
      .run("message", "conversation", 0, "assistant", "Keep this history");
    sqlite
      .prepare(
        "INSERT INTO Run (id,userId,conversationId,clientId,assistantId,model,status,inputTokens,outputTokens,cost,usageComplete) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "run",
        "owner",
        "conversation",
        "client",
        "message",
        "claude-sonnet-4-6",
        "complete",
        42,
        10,
        0.000276,
        1,
      );
    for (const migration of migrations.slice(1))
      sqlite.exec(
        readFileSync(`prisma/migrations/${migration}/migration.sql`, "utf8"),
      );
    expect(sqlite.prepare("SELECT text FROM Message").get()).toEqual({
      text: "Keep this history",
    });
    expect(
      sqlite.prepare("SELECT passwordHash,workspaceLayout FROM User").get(),
    ).toEqual({ passwordHash: "existing-hash", workspaceLayout: "{}" });
    expect(sqlite.prepare("SELECT paused,archived FROM Agent").get()).toEqual({
      paused: 0,
      archived: 0,
    });
    expect(sqlite.prepare("SELECT provider,cost FROM Run").get()).toEqual({
      provider: "anthropic",
      cost: 0.000276,
    });
    expect(
      sqlite
        .prepare("SELECT source,chargedMicros,status FROM SpendEntry")
        .get(),
    ).toEqual({ source: "legacy", chargedMicros: 276, status: "settled" });
    expect(
      sqlite
        .prepare(
          "SELECT spentMicros,reservedMicros,unknownCalls FROM BudgetMonth",
        )
        .get(),
    ).toEqual({ spentMicros: 276, reservedMicros: 0, unknownCalls: 0 });
    const row = sqlite.prepare("SELECT encrypted FROM Credential").get() as {
      encrypted: string;
    };
    expect(row.encrypted).toBe(encrypted);
    expect(decryptKey(row.encrypted, "owner", "anthropic")).toBe(
      "sk-ant-fixture-migration",
    );
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  } finally {
    sqlite.close();
  }
});
