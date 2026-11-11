#!/usr/bin/env bash
# Builds the demo project for docs/demo/demo.tape: a tiny repo whose project
# settings wire Claude Code to a running agent-memory-mcp server, with the
# capture and context hooks and the MCP tools. Usage: setup.sh <folder>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="${1:?usage: setup.sh <folder>}"
URL="${MEMORY_URL:-http://127.0.0.1:8787}"
KEY="${MEMORY_API_KEY:?set MEMORY_API_KEY to the API key of the server}"
USER_ID="${MEMORY_USER:-demo-$(date +%s)}"
PROJECT="invoices"

mkdir -p "$DIR/.claude"
cd "$DIR"
git init -q
printf '# Invoices\n\nA small billing tool.\n' > README.md

ENV="MEMORY_URL=$URL MEMORY_API_KEY=$KEY MEMORY_USER=$USER_ID MEMORY_PROJECT=$PROJECT"
cat > .claude/settings.json <<JSON
{
  "permissions": {"deny": ["Read(~/**)"]},
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "command", "command": "$ENV node $ROOT/packages/adapters/dist/context.js"}]}],
    "SessionEnd": [{"hooks": [{"type": "command", "command": "$ENV node $ROOT/packages/adapters/dist/capture.js"}]}]
  }
}
JSON
cat > .mcp.json <<JSON
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["$ROOT/packages/server/dist/cli.js", "--url", "$URL", "--user", "$USER_ID", "--project", "$PROJECT"],
      "env": {"MEMORY_API_KEY": "$KEY"}
    }
  }
}
JSON
printf 'export MEMORY_URL=%s MEMORY_USER=%s MEMORY_PROJECT=%s\n' "$URL" "$USER_ID" "$PROJECT" > .demo-env
echo "$DIR ready for user $USER_ID"
