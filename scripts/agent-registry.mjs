import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { agentPresets } from "./agent-presets.mjs";
import { currentProjectId } from "./project-store.mjs";

export const registrationSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  participant: z.string().trim().min(1).max(80),
  preset: z.enum(["orchestrator", "developer", "reviewer"]),
  instructions: z.string().trim().max(4000).default(""),
});

export function agentRegistry(database) {
  const hadMembers = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='project_agent'",
    )
    .get();
  const hadManagers = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='project_manager'",
    )
    .get();
  database.exec(`
    CREATE TABLE IF NOT EXISTS shared_agent (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, participant TEXT NOT NULL,
      preset TEXT NOT NULL, instructions TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS shared_manager (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), agent_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_agent (
      project_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      PRIMARY KEY (project_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS project_manager (
      project_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL
    );
  `);
  if (!hadMembers)
    database.exec(
      "INSERT OR IGNORE INTO project_agent SELECT 'default', id FROM shared_agent",
    );
  if (!hadManagers)
    database.exec(
      "INSERT OR IGNORE INTO project_manager SELECT 'default', agent_id FROM shared_manager",
    );
  const read = database.prepare(
    "SELECT id, name, participant, preset, instructions, revoked FROM shared_agent ORDER BY rowid",
  );
  function allAgents() {
    return read.all().map((agent) => ({
      ...agent,
      revoked: Boolean(agent.revoked),
      skills: agentPresets[agent.preset].skills.map((skill) => skill.name),
    }));
  }
  function agents() {
    const members = new Set(
      database
        .prepare("SELECT agent_id FROM project_agent WHERE project_id = ?")
        .all(currentProjectId())
        .map((row) => row.agent_id),
    );
    return allAgents().filter((agent) => members.has(agent.id));
  }
  function managerId() {
    return (
      database
        .prepare("SELECT agent_id FROM project_manager WHERE project_id = ?")
        .get(currentProjectId())?.agent_id ?? null
    );
  }
  return {
    agents,
    allAgents,
    managerId,
    canAccess(agentId, projectId) {
      return Boolean(
        database
          .prepare(
            "SELECT 1 FROM project_agent WHERE project_id = ? AND agent_id = ?",
          )
          .get(projectId, agentId),
      );
    },
    include(agentIds, projectId = currentProjectId()) {
      if (
        agentIds.some(
          (id) =>
            !allAgents().some((agent) => agent.id === id && !agent.revoked),
        )
      )
        return false;
      const insert = database.prepare(
        "INSERT OR IGNORE INTO project_agent (project_id, agent_id) VALUES (?, ?)",
      );
      for (const id of agentIds) insert.run(projectId, id);
      return true;
    },
    exclude(agentId, current) {
      if (
        managerId() === agentId ||
        current.tasks.some((thread) => thread.task.agentId === agentId)
      )
        return false;
      return (
        database
          .prepare(
            "DELETE FROM project_agent WHERE project_id = ? AND agent_id = ?",
          )
          .run(currentProjectId(), agentId).changes > 0
      );
    },
    authenticate(hash) {
      const row = database
        .prepare(
          "SELECT id FROM shared_agent WHERE token_hash = ? AND revoked = 0",
        )
        .get(hash.toString("hex"));
      return row ? allAgents().find((agent) => agent.id === row.id) : null;
    },
    create(input) {
      const profile = registrationSchema.parse(input);
      if (allAgents().filter((agent) => !agent.revoked).length >= 32)
        throw Error("This project already has 32 active agents.");
      const id = randomUUID();
      const key = randomBytes(32).toString("hex");
      const hash = createHash("sha256").update(`Bearer ${key}`).digest("hex");
      database
        .prepare(
          "INSERT INTO shared_agent (id, name, participant, preset, instructions, token_hash) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          profile.name,
          profile.participant,
          profile.preset,
          profile.instructions,
          hash,
        );
      database
        .prepare(
          "INSERT INTO project_agent (project_id, agent_id) VALUES (?, ?)",
        )
        .run(currentProjectId(), id);
      return { agent: agents().find((agent) => agent.id === id), key };
    },
    select(id, current) {
      const agent = agents().find(
        (agent) =>
          agent.id === id && !agent.revoked && agent.preset === "orchestrator",
      );
      if (!agent) return false;
      database
        .prepare(
          "INSERT INTO project_manager (project_id, agent_id) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET agent_id=excluded.agent_id",
        )
        .run(currentProjectId(), id);
      return true;
    },
    revoke(id, current) {
      if (
        current.tasks.some((thread) => thread.task.agentId === id) ||
        (managerId() === id && (current.task || current.decision)) ||
        !agents().some((agent) => agent.id === id)
      )
        return false;
      database
        .prepare("UPDATE shared_agent SET revoked = 1 WHERE id = ?")
        .run(id);
      database
        .prepare("DELETE FROM project_manager WHERE agent_id = ?")
        .run(id);
      return true;
    },
  };
}
