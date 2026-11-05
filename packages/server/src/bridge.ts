import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const JSONRPC_INTERNAL_ERROR = -32603;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Forwards MCP messages both ways. Closing either side closes the other. */
export async function bridge(
  local: Transport,
  remote: Transport,
): Promise<void> {
  // stdout carries the protocol, so diagnostics must go to stderr.
  const log = (error: unknown): void => {
    process.stderr.write(`agent-memory-mcp bridge: ${messageOf(error)}\n`);
  };

  // A request that never reaches the server must still get a reply, or the
  // client just hangs until its timeout and never sees the real cause.
  const replyWithError = (message: JSONRPCMessage, error: unknown): void => {
    log(error);
    if (!("method" in message) || !("id" in message)) return;
    local
      .send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: JSONRPC_INTERNAL_ERROR, message: messageOf(error) },
      })
      .catch(log);
  };

  local.onmessage = (message) => {
    remote.send(message).catch((error) => replyWithError(message, error));
  };
  remote.onmessage = (message) => {
    local.send(message).catch(log);
  };
  local.onerror = log;
  remote.onerror = log;

  // Each close() fires onclose again, so without this guard the two sides
  // would keep closing each other forever.
  let closed = false;
  const closeBoth = (): void => {
    if (closed) return;
    closed = true;
    local.close().catch(log);
    remote.close().catch(log);
  };
  local.onclose = closeBoth;
  remote.onclose = closeBoth;

  await remote.start();
  await local.start();
}
