import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export function openDispatchStore(database) {
  database.exec(
    "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;" +
      "CREATE TABLE IF NOT EXISTS assignments (issue INTEGER PRIMARY KEY, agent TEXT NOT NULL, comment TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS deliveries (issue INTEGER PRIMARY KEY, delivery TEXT NOT NULL UNIQUE, state TEXT NOT NULL, session TEXT);",
  );
  return database;
}

function reply(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

export function createDispatcher({
  config,
  credentials,
  database,
  fire = fetch,
}) {
  const assignment = database.prepare(
    "SELECT agent, comment FROM assignments WHERE issue = ?",
  );
  const reserve = database.prepare(
    "INSERT INTO deliveries VALUES (?, ?, 'unconfirmed', NULL) ON CONFLICT DO NOTHING",
  );
  const finish = database.prepare(
    "UPDATE deliveries SET state = 'started', session = ? WHERE issue = ?",
  );
  return async (issue, delivery, onAccepted = () => {}) => {
    const saved = assignment.get(issue);
    if (
      !saved ||
      !Object.hasOwn(config.agents, saved.agent) ||
      !reserve.run(issue, delivery).changes
    )
      return false;
    onAccepted();
    try {
      const { fireUrl, token } = credentials.agents[saved.agent];
      const run = await fire(fireUrl, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(45000),
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "experimental-cc-routine-2026-04-01",
        },
        body: JSON.stringify({
          text:
            "Vizor wake-up for " +
            config.repository +
            "#" +
            issue +
            ". Check the authorized assignment at " +
            saved.comment +
            ". This wake-up only points to the assignment. Verify its author and repository before acting.",
        }),
      });
      if (!run.ok) {
        console.error(
          "Dispatch #" +
            issue +
            " remains unconfirmed. Claude returned HTTP " +
            run.status +
            ".",
        );
        return true;
      }
      const result = await run.json();
      const sessionId = result?.claude_code_session_id;
      const sessionUrl =
        typeof result?.claude_code_session_url === "string"
          ? URL.parse(result.claude_code_session_url)
          : null;
      if (
        sessionUrl?.origin === "https://claude.ai" &&
        !sessionUrl.username &&
        !sessionUrl.password &&
        /^\/code\/(?:session|cse)_[A-Za-z0-9_-]+$/.test(sessionUrl.pathname)
      ) {
        finish.run(sessionUrl.origin + sessionUrl.pathname, issue);
        return true;
      }
      if (
        typeof sessionId === "string" &&
        /^(?:session|cse)_[A-Za-z0-9_-]+$/.test(sessionId)
      ) {
        finish.run("https://claude.ai/code/" + sessionId, issue);
        return true;
      }
      console.error(
        "Dispatch #" +
          issue +
          " remains unconfirmed. Claude returned no recognized session.",
      );
    } catch (error) {
      // A timeout can occur after the provider starts the run. Preserve the receipt.
      console.error(
        "Dispatch #" +
          issue +
          " remains unconfirmed (" +
          error.name +
          "). Check the scheduled-task history.",
      );
    }
    return true;
  };
}

export function createListener({
  config,
  credentials,
  database,
  fire = fetch,
}) {
  const assignment = database.prepare(
    "SELECT agent, comment FROM assignments WHERE issue = ?",
  );
  const dispatch = createDispatcher({ config, credentials, database, fire });
  return createServer({ requestTimeout: 10000 }, async (request, response) => {
    try {
      if (request.url !== "/webhooks/github" || request.method !== "POST")
        return reply(response, 404, { error: "Unknown route." });
      const signature = request.headers["x-hub-signature-256"];
      if (
        typeof signature !== "string" ||
        !/^sha256=[a-f0-9]{64}$/.test(signature)
      )
        return reply(response, 401, { error: "Invalid signature." });
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 262144)
          return reply(response, 413, { error: "Payload too large." });
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const expected = createHmac("sha256", credentials.webhookSecret)
        .update(bytes)
        .digest();
      if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex")))
        return reply(response, 401, { error: "Invalid signature." });
      if (request.headers["x-github-event"] !== "issues")
        return reply(response, 200, { ignored: true });
      let event;
      try {
        event = JSON.parse(bytes.toString("utf8"));
      } catch {
        return reply(response, 400, { error: "Invalid JSON." });
      }
      const issue = event?.issue?.number;
      if (
        event?.action !== "labeled" ||
        event.label?.name !== config.dispatchLabel ||
        event.repository?.full_name?.toLowerCase() !==
          config.repository.toLowerCase() ||
        !Number.isSafeInteger(issue) ||
        issue < 1 ||
        event.issue.state !== "open"
      )
        return reply(response, 200, { ignored: true });

      const saved = assignment.get(issue);
      const agent =
        saved &&
        Object.hasOwn(config.agents, saved.agent) &&
        config.agents[saved.agent];
      const labels = Array.isArray(event.issue.labels)
        ? event.issue.labels.map((label) => label.name)
        : [];
      if (
        !agent ||
        !labels.includes(agent.label) ||
        Object.values(config.agents).some(
          (other) => other !== agent && labels.includes(other.label),
        ) ||
        !agent.trustedManagers.some(
          (manager) =>
            manager.toLowerCase() === event.sender?.login?.toLowerCase(),
        )
      )
        return reply(response, 200, { ignored: true });

      const delivery = request.headers["x-github-delivery"];
      if (typeof delivery !== "string" || !/^[a-f0-9-]{36}$/i.test(delivery))
        return reply(response, 400, {
          error: "Missing or invalid delivery ID.",
        });
      const started = await dispatch(issue, delivery, () =>
        reply(response, 202, { accepted: true }),
      );
      if (!started) return reply(response, 200, { duplicate: true });
    } catch {
      return reply(response, 500, { error: "Webhook processing failed." });
    }
  });
}
