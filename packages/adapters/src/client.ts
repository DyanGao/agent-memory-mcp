import { userInfo } from "node:os";
import { basename } from "node:path";

const REQUEST_TIMEOUT_MS = 3000;

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  source?: string;
}

/** Must resolve the same user and project as the server's stdio bridge. */
export function connectionFor(cwd: string | undefined) {
  const apiKey = process.env.MEMORY_API_KEY;
  if (!apiKey) throw new Error("MEMORY_API_KEY is not set");
  return {
    url: process.env.MEMORY_URL ?? "http://127.0.0.1:8787",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "x-memory-user": process.env.MEMORY_USER ?? userInfo().username,
      "x-memory-project":
        process.env.MEMORY_PROJECT ?? basename(cwd ?? process.cwd()),
    },
  };
}

export async function post(
  connection: ReturnType<typeof connectionFor>,
  path: string,
  body: unknown,
): Promise<unknown> {
  const response = await fetch(`${connection.url}${path}`, {
    method: "POST",
    headers: connection.headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** A memory problem must never disturb the session, so failures are only logged. */
export async function runHook(name: string, hook: () => Promise<void>) {
  try {
    await hook();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${name}: ${message}\n`);
  }
  process.exitCode = 0;
}
