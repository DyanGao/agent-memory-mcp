# @dyangao/agent-memory-mcp

The client for [agent-memory-mcp](https://github.com/DyanGao/agent-memory-mcp), a self-hostable, GDPR-aware long-term memory server for AI agents. This package does not store anything itself. It connects an agent to a server you run, by default on `http://127.0.0.1:8787`. To start one, follow the [quickstart](https://github.com/DyanGao/agent-memory-mcp#quickstart).

It has three commands:

| Command | What it does |
|---|---|
| `agent-memory-mcp` | A stdio MCP server that forwards to your memory server, with the tools `memory_write`, `memory_search`, `memory_forget`, `memory_list` and `memory_context_for` |
| `agent-memory-capture` | A Claude Code `SessionEnd` hook that sends the session to the server for distillation |
| `agent-memory-context` | A Claude Code `SessionStart` hook that injects the memories relevant to the session |

All three need `MEMORY_API_KEY`, the key set in your server's `.env`. It is read from the environment, so it never appears in a process listing.

## Register the MCP server

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@dyangao/agent-memory-mcp", "--url", "http://127.0.0.1:8787"],
      "env": { "MEMORY_API_KEY": "<from your .env>" }
    }
  }
}
```

`--user` defaults to your login name and `--project` to the current folder's name. Scope comes from this configuration, never from tool arguments, so a prompt-injected agent cannot reach another user's memories.

## Automatic capture in Claude Code

Install once, then add the hooks to `.claude/settings.json`, with `MEMORY_API_KEY` set in your environment:

```bash
npm install -g @dyangao/agent-memory-mcp
```

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "agent-memory-context" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "agent-memory-capture" }] }]
  }
}
```

The hooks never block a session: if the server is down they log to stderr and exit cleanly. `MEMORY_URL`, `MEMORY_USER` and `MEMORY_PROJECT` override the defaults.

## Licence

Apache-2.0
