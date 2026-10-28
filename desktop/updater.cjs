const {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} = require("node:fs");
const { join } = require("node:path");
const { verifyManifest } = require("./update-policy.cjs");
class UpdateManager {
  constructor({
    updater,
    source,
    currentVersion,
    home,
    publish,
    activity,
    stopBackend,
    makeToken,
    disabled = false,
  }) {
    Object.assign(this, {
      updater,
      source,
      currentVersion,
      publish,
      activity,
      stopBackend,
      makeToken,
    });
    this.preferences = join(home, "updates.json");
    this.enabled = true;
    try {
      if (existsSync(this.preferences))
        this.enabled =
          JSON.parse(readFileSync(this.preferences, "utf8")).automatic !==
          false;
    } catch {
      /* Default stays enabled for a missing/corrupt preference. */
    }
    this.disabled = disabled;
    this.checking = false;
    this.downloading = false;
    this.ready = false;
    this.installing = false;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.logger = null;
    // Replace electron-updater's per-install rollout identifier with a shared,
    // non-identifying value. Update checks are not an analytics channel.
    updater.requestHeaders = { "x-user-staging-id": "vizor" };
    updater.on("error", () => this.error());
    updater.on("download-progress", (progress) => {
      if (this.enabled && !this.disabled)
        this.set("downloading", {
          progress: Math.max(
            0,
            Math.min(100, Math.round(progress.percent || 0)),
          ),
        });
    });
    updater.on("update-downloaded", () => {
      this.ready = true;
      updater.autoInstallOnAppQuit = this.enabled && !this.disabled;
      if (this.enabled && !this.disabled) this.set("ready");
    });
    this.state = {
      state: disabled || !this.enabled ? "disabled" : "idle",
      automatic: this.enabled && !disabled,
      currentVersion,
    };
  }
  snapshot() {
    return { ...this.state };
  }
  set(state, fields = {}) {
    this.state = {
      state,
      currentVersion: this.currentVersion,
      automatic: this.enabled && !this.disabled,
      ...(this.version ? { version: this.version } : {}),
      ...fields,
    };
    this.publish(this.snapshot());
  }
  error() {
    if (!this.disabled && this.enabled && !this.installing)
      this.set("error", {
        message:
          "Updates couldn't be checked. You can keep using Vizor and try again later.",
      });
  }
  start() {
    if (this.disabled) return;
    this.initialTimer = setTimeout(() => {
      if (this.enabled) void this.check();
    }, this.source.initialDelay ?? 15000);
    this.initialTimer.unref?.();
    this.interval = setInterval(
      () => {
        if (this.enabled) void this.check();
      },
      6 * 60 * 60 * 1000,
    );
    this.interval.unref?.();
  }
  dispose() {
    clearTimeout(this.initialTimer);
    clearInterval(this.interval);
    this.token?.cancel();
  }
  async check() {
    if (this.disabled || this.checking || this.downloading || this.installing)
      return this.snapshot();
    if (this.ready) {
      this.set("ready");
      return this.snapshot();
    }
    this.checking = true;
    this.set("checking");
    try {
      const result = await this.updater.checkForUpdates();
      const info = result?.updateInfo;
      const { newer } = require("./update-policy.cjs");
      if (!info || !newer(info.version, this.currentVersion)) {
        this.set("current");
        return this.snapshot();
      }
      const [bytes, signature] = await Promise.all([
        this.source.readAsset(info.version, "vizor-update.json"),
        this.source.readAsset(info.version, "vizor-update.sig"),
      ]);
      verifyManifest(
        info,
        bytes,
        signature.toString("utf8"),
        this.source.publicKey,
        this.currentVersion,
      );
      this.version = info.version;
      // A preference change while verifying must not start an unwanted download.
      if (!this.enabled) {
        this.set("available");
        return this.snapshot();
      }
      this.token = this.makeToken();
      this.downloading = true;
      this.set("downloading", { progress: 0 });
      await this.updater.downloadUpdate(this.token);
    } catch {
      this.error();
    } finally {
      this.checking = false;
      this.downloading = false;
      this.token = undefined;
    }
    return this.snapshot();
  }
  async automatic(value) {
    if (typeof value !== "boolean")
      throw new Error("Expected an update preference");
    writeFileSync(
      `${this.preferences}.tmp`,
      JSON.stringify({ automatic: value }) + "\n",
      { mode: 0o600 },
    );
    renameSync(`${this.preferences}.tmp`, this.preferences);
    this.enabled = value;
    this.updater.autoInstallOnAppQuit = value && this.ready && !this.disabled;
    if (!value) {
      this.token?.cancel();
      this.set("disabled");
    } else if (this.ready) {
      this.updater.addQuitHandler?.();
      this.set("ready");
    } else if (!this.disabled) void this.check();
    return this.snapshot();
  }
  async restart() {
    if (!this.ready || this.disabled || this.installing)
      return { ok: false, reason: "not-ready" };
    let active = null;
    try {
      active = await this.activity();
    } catch {
      /* Unknown activity must not restart the app. */
    }
    if (active !== 0) {
      this.set("ready", {
        message: "Finish or stop the current reply before restarting.",
      });
      return { ok: false, reason: "busy" };
    }
    this.installing = true;
    this.set("installing");
    try {
      await this.stopBackend();
      this.updater.quitAndInstall(true, true);
      return { ok: true };
    } catch {
      this.installing = false;
      this.error();
      return { ok: false, reason: "failed" };
    }
  }
}
module.exports = { UpdateManager };
