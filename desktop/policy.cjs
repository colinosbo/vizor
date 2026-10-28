const { isAbsolute, join, resolve } = require("node:path");
function workspacePaths(localAppData, override) {
  if (!isAbsolute(localAppData || "") || (override && !isAbsolute(override)))
    throw new Error("Vizor needs an absolute local data directory.");
  const home = resolve(override || join(localAppData, "Vizor"));
  return {
    home,
    workspace: join(home, "workspace"),
    shell: join(home, "shell"),
  };
}
function localNavigation(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}
function externalLink(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
      return null;
    return parsed.href;
  } catch {
    return null;
  }
}
module.exports = { workspacePaths, localNavigation, externalLink };
