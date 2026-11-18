// Vizor runtime setup. Installs or upgrades this package for the current user.
//   node setup.mjs [--home <dir>] [--no-path]
// Safe to rerun. Project configuration, credentials, queues and receipts live in
// each project's .vizor folder and are never copied or changed here.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { requireNode24 } = await import("./runtime/scripts/runtime-control.mjs");
const installer = await import("./runtime/scripts/installer.mjs");

try {
  requireNode24();
  const args = process.argv.slice(2);
  const homeIndex = args.indexOf("--home");
  const home =
    homeIndex >= 0
      ? installer.vizorHome({ env: { VIZOR_HOME: args[homeIndex + 1] } })
      : installer.vizorHome();
  const result = installer.withInstallLock(home, () => {
    const files = installer.installFiles(here, home);
    const before = installer.readInstall(home).current;
    installer.activate(home, files.version, installer.defaultOps());
    return { ...files, before };
  });
  const bin = join(home, "bin");
  console.log(
    (result.before && result.before !== result.version
      ? "Upgraded Vizor " + result.before + " -> " + result.version
      : "Installed Vizor " + result.version) +
      " at " +
      result.dir,
  );
  if (!args.includes("--no-path")) {
    if (process.platform === "win32") {
      // -Command joins trailing arguments into the script, so embed the path.
      const quoted = "'" + bin.replaceAll("'", "''") + "'";
      const ps =
        "$b=" +
        quoted +
        ";$p=[Environment]::GetEnvironmentVariable('Path','User');" +
        "if(-not (($p -split ';') -contains $b)){[Environment]::SetEnvironmentVariable('Path',(@($p,$b)|Where-Object{$_}) -join ';','User');'added'}else{'present'}";
      const r = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", ps],
        { encoding: "utf8", windowsHide: true },
      );
      if (r.stdout?.trim() === "added")
        console.log(
          "Added " +
            bin +
            " to your user PATH. Open a new terminal to use `vizor`.",
        );
    } else {
      console.log('Add Vizor to PATH:  export PATH="' + bin + ':$PATH"');
    }
  }
  console.log("Next: open your project folder and run `vizor connect --help`.");
  console.log(
    "You can delete this extracted folder; Vizor runs from " + home + ".",
  );
} catch (error) {
  console.error("Vizor setup failed: " + error.message);
  process.exitCode = 1;
}
