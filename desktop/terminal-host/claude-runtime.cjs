const { findTool } = require("./tools.cjs");
const { environment } = require("./sessions.cjs");
const { join } = require("node:path");

function subscriptionEnvironment(source = process.env) {
  const env = environment(source);
  // A subscription session must not inherit alternate paid provider routing.
  for (const key of Object.keys(env))
    if (
      /^(ANTHROPIC_|CLAUDE_CODE_USE_|VIZOR_|MASTER_KEY|DATABASE_URL|NODE_OPTIONS|ELECTRON_RUN_AS_NODE)/i.test(
        key,
      )
    )
      delete env[key];
  return env;
}
function runtime(home) {
  return {
    binary: findTool("claude-code", home),
    cwd: join(home, "orchestrator"),
    env: {
      ...subscriptionEnvironment(),
      CLAUDE_CONFIG_DIR: join(home, "claude-subscription"),
    },
  };
}
module.exports = { runtime, subscriptionEnvironment };
