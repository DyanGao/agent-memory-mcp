#!/usr/bin/env node
import { userInfo } from "node:os";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bridge } from "./bridge.js";
// Not ./http.js: the published bridge must not pull in the server.
import { PROJECT_HEADER, USER_HEADER } from "./headers.js";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:8787" },
    user: { type: "string", default: userInfo().username },
    project: { type: "string", default: basename(process.cwd()) },
  },
});

// Read from the environment so the key never appears in a process listing.
const apiKey = process.env.MEMORY_API_KEY;
if (!apiKey) {
  process.stderr.write("agent-memory-mcp: set MEMORY_API_KEY\n");
  process.exit(1);
}

const remote = new StreamableHTTPClientTransport(new URL("/mcp", values.url), {
  requestInit: {
    headers: {
      authorization: `Bearer ${apiKey}`,
      [USER_HEADER]: values.user,
      [PROJECT_HEADER]: values.project,
    },
  },
});

await bridge(new StdioServerTransport(), remote);
