const publicKey = require("./update-key.cjs");
const allowedHosts = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
async function readAsset(version, name) {
  let url = `https://github.com/colinosbo/vizor/releases/download/v${version}/${name}`;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      !allowedHosts.has(parsed.hostname) ||
      parsed.username ||
      parsed.password
    )
      throw new Error("Untrusted update host");
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "Vizor-desktop-updater" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = new URL(response.headers.get("location"), url).href;
      continue;
    }
    if (
      !response.ok ||
      Number(response.headers.get("content-length") || 0) > 65536
    )
      throw new Error("Update verification file unavailable");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) {
        await reader.cancel();
        throw new Error("Update verification file too large");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Too many update redirects");
}
module.exports = {
  publicKey,
  readAsset,
  feed: {
    provider: "github",
    owner: "colinosbo",
    repo: "vizor",
    private: false,
    releaseType: "release",
  },
  initialDelay: 15000,
};
