// One pm2 process per person: every users/<name>/.env becomes an app "zalo-<name>".
const fs = require("node:fs");
const path = require("node:path");

const usersDir = path.join(__dirname, "users");
const users = fs.existsSync(usersDir)
  ? fs.readdirSync(usersDir).filter((name) => fs.existsSync(path.join(usersDir, name, ".env")))
  : [];

module.exports = {
  apps: users.map((name) => ({
    name: `zalo-${name}`,
    cwd: __dirname,
    script: "src/index.ts",
    interpreter: "node",
    interpreter_args: "--import tsx --disable-warning=ExperimentalWarning",
    env: { USER_DIR: path.join(usersDir, name) },
    // Back off between restarts so a lost session doesn't hammer Zalo.
    exp_backoff_restart_delay: 60000,
    max_restarts: 20,
  })),
};
