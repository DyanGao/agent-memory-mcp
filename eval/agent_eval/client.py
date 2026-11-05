"""Talks to a running stack the way real clients do: MCP for tools, REST for the rest."""

import json
import subprocess
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

URL = "http://127.0.0.1:8788"
API_KEY = "eval-only-key"
PROJECT = "eval"
ROOT = Path(__file__).resolve().parents[2]


def headers(user: str) -> dict[str, str]:
    return {
        "authorization": f"Bearer {API_KEY}",
        "x-memory-user": user,
        "x-memory-project": PROJECT,
    }


@asynccontextmanager
async def mcp_session(user: str):
    http = httpx2.AsyncClient(headers=headers(user), timeout=120)
    async with http, streamable_http_client(f"{URL}/mcp", http_client=http) as streams:
        async with ClientSession(streams[0], streams[1]) as session:
            await session.initialize()
            yield session


async def tool(session: ClientSession, name: str, **arguments) -> object:
    result = await session.call_tool(name, arguments)
    if result.is_error:
        raise RuntimeError(f"{name} failed: {result.content[0].text}")
    return json.loads(result.content[0].text)


def rest(user: str) -> httpx.Client:
    return httpx.Client(base_url=URL, headers=headers(user), timeout=120)


def wait_for_distill(client: httpx.Client, session_id: str, timeout: float = 300) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/v1/sessions/{session_id}/status")
        if response.status_code == 200:
            return response.json()
        time.sleep(1)
    raise TimeoutError(f"Session {session_id} was not distilled in {timeout}s")


def sql(statement: str) -> str:
    """Runs as the database owner, so it sees everything, past any RLS."""
    command = [
        "docker", "compose", "-p", "agent-memory-eval", "--env-file", "eval/eval.env",
        "exec", "-T", "postgres", "psql", "-U", "eval_owner", "-d",
        "agent_memory_eval", "-Atc", statement,
    ]
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def write_results(name: str, payload: dict) -> Path:
    directory = ROOT / "eval" / "results" / time.strftime("%Y-%m-%d")
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}.json"
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    return path
