import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { readRuntimeSnapshot } from "./runtime-snapshot.mjs";
const files = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/dashboard.css": ["dashboard.css", "text/css; charset=utf-8"],
  "/dashboard.js": ["dashboard.js", "text/javascript; charset=utf-8"],
};
export async function dashboardSnapshot({ file }) {
  return readRuntimeSnapshot(file).snapshot;
}

export function serveDashboard({ queueFile, port }) {
  const allowedHosts = new Set(["127.0.0.1:" + port, "localhost:" + port]);
  const assets = new Map(
    Object.entries(files).map(([path, [name, contentType]]) => [
      path,
      {
        contentType,
        contents: readFileSync(new URL("./dashboard/" + name, import.meta.url)),
      },
    ]),
  );
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    if (
      !allowedHosts.has(request.headers.host) ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
      return;
    }
    if (request.url === "/api/queue") {
      const result = readRuntimeSnapshot(queueFile);
      const latest = result.snapshot;
      response.writeHead(latest ? 200 : 503, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(result));
      return;
    }
    const asset = assets.get(request.url);
    if (!asset) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "Content-Type": asset.contentType })
      .end(asset.contents);
  });
  server.listen(port, "127.0.0.1", () =>
    console.log("Vizor dashboard: http://127.0.0.1:" + port),
  );
  return server;
}
