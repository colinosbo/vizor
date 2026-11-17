import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { readQueue, scheduleTick } from "./scheduler.mjs";

const execute = promisify(execFile);
const files = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/dashboard.css": ["dashboard.css", "text/css; charset=utf-8"],
  "/dashboard.js": ["dashboard.js", "text/javascript; charset=utf-8"],
};

export async function dashboardSnapshot({ config, databaseFile, file, github }) {
  const queue = readQueue(file);
  const db = new DatabaseSync(databaseFile, { readOnly: true, timeout: 5000 });
  const tasks = [];
  try {
    await scheduleTick({
      db, config, queue, preview: true, log() {},
      github: (method, ...args) => {
        if (method !== "GET") throw Error("Dashboard requests are read-only.");
        return github(method, ...args);
      },
      onStatus: (task) => tasks.push(task),
    });
  } finally {
    db.close();
  }
  return {
    repository: config.repository,
    updatedAt: new Date().toISOString(),
    paused: queue.paused,
    agents: Object.entries(config.agents).map(([id, { name }]) => ({ id, name })),
    tasks,
  };
}

export function serveDashboard({ executable, queueFile, port }) {
  const allowedHosts = new Set(["127.0.0.1:" + port, "localhost:" + port]);
  const assets = new Map(Object.entries(files).map(([path, [name, contentType]]) => [
    path, { contentType, contents: readFileSync(new URL("./dashboard/" + name, import.meta.url)) },
  ]));
  let latest;
  let attemptAt = 0;
  let pending;
  let unavailable = false;

  function refresh() {
    if (pending) return pending;
    if (Date.now() - attemptAt < 55000) return;
    attemptAt = Date.now();
    pending = execute(process.execPath, [executable, "dashboard-snapshot", queueFile], {
      windowsHide: true, timeout: 55000, maxBuffer: 2 * 1024 * 1024,
    }).then(({ stdout }) => {
      latest = JSON.parse(stdout);
      unavailable = false;
    }).catch(() => {
      unavailable = true;
    }).finally(() => { pending = undefined; });
    return pending;
  }

  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (!allowedHosts.has(request.headers.host) || request.headers["sec-fetch-site"] === "cross-site") {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
      return;
    }
    if (request.url === "/api/queue") {
      await refresh();
      response.writeHead(latest ? 200 : 503, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ snapshot: latest ?? null, stale: unavailable }));
      return;
    }
    const asset = assets.get(request.url);
    if (!asset) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": asset.contentType }).end(asset.contents);
  });
  server.listen(port, "127.0.0.1", () => console.log("Vizor dashboard: http://127.0.0.1:" + port));
  return server;
}
