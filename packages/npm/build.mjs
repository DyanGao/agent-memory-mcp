// Assembles the published client from the workspace's compiled output: the
// stdio bridge from packages/server and the Claude Code hooks from
// packages/adapters. Only these files ship, so the package depends on the MCP
// SDK alone and never on the server, Postgres or Fastify. Run `pnpm build` first.
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";

const root = new URL("../../", import.meta.url);
const out = new URL("dist/", import.meta.url);
const files = {
  "packages/server/dist/cli.js": "cli.js",
  "packages/server/dist/bridge.js": "bridge.js",
  "packages/server/dist/headers.js": "headers.js",
  "packages/adapters/dist/capture.js": "capture.js",
  "packages/adapters/dist/context.js": "context.js",
  "packages/adapters/dist/client.js": "client.js",
  "packages/adapters/dist/transcript.js": "transcript.js",
};
const commands = ["cli.js", "capture.js", "context.js"];

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const [from, to] of Object.entries(files)) {
  copyFileSync(new URL(from, root), new URL(to, out));
}
for (const command of commands) {
  if (
    !readFileSync(new URL(command, out), "utf8").startsWith(
      "#!/usr/bin/env node",
    )
  ) {
    throw new Error(
      `${command} has no #!/usr/bin/env node line, so it cannot run as a command`,
    );
  }
}
copyFileSync(new URL("LICENSE", root), new URL("LICENSE", import.meta.url));
process.stdout.write(
  `assembled ${Object.keys(files).length} files in packages/npm/dist\n`,
);
