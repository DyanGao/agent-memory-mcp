import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "./api.js";
import type {
  AuditEntry,
  Connection,
  ForgetPreview,
  ForgetReceipt,
  ForgetRequest,
  Memory,
  Score,
  SearchResult,
} from "./api.js";

const VIEWS = ["Memories", "Search", "Forget", "Activity", "Export"] as const;
type View = (typeof VIEWS)[number];

const TYPES = ["fact", "decision", "preference", "todo", "error_fix"];
const TYPE_LABELS: Record<string, string> = {
  fact: "Fact",
  decision: "Decision",
  preference: "Preference",
  todo: "To do",
  error_fix: "Error fix",
};

const ACTION_LABELS: Record<string, string> = {
  write: "Saved",
  edit: "Edited",
  supersede: "Replaced older memories",
  forget: "Forgotten",
  retention: "Expired",
};

const STORAGE_KEY = "agent-memory-connection";

/** Kept for this tab only. Storage can be blocked, which is fine. */
function loadConnection(): Connection | null {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return stored ? (JSON.parse(stored) as Connection) : null;
  } catch {
    return null;
  }
}

function saveConnection(connection: Connection | null): void {
  try {
    if (connection) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // The session simply will not survive a reload.
  }
}

const formatDate = (value: string): string =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

const countMemories = (count: number): string =>
  count === 1 ? "1 memory" : `${count} memories`;

const countEntries = (count: number): string =>
  count === 1 ? "1 transcript entry" : `${count} transcript entries`;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

function ErrorNote({ message }: { message: string | null }) {
  return message ? (
    <p className="error" role="alert">
      {message}
    </p>
  ) : null;
}

function SignIn({ onConnect }: { onConnect: (c: Connection) => void }) {
  const [user, setUser] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const connection = { user: user.trim(), apiKey };
    try {
      await api.list(connection, { type: "", includeOutdated: false });
      onConnect(connection);
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  return (
    <main className="signin">
      <h1>What your agents remember</h1>
      <p>Read, correct or erase anything stored about a person.</p>
      <form onSubmit={submit}>
        <label>
          Person
          <input
            value={user}
            onChange={(e) => setUser(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          API key
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            required
          />
        </label>
        <button className="primary">Open memories</button>
        <ErrorNote message={error} />
      </form>
    </main>
  );
}

function MemoryRow({
  memory,
  connection,
  onChanged,
}: {
  memory: Memory;
  connection: Connection;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"read" | "edit" | "delete">("read");
  const [draft, setDraft] = useState(memory.content);
  const [preview, setPreview] = useState<ForgetPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const outdated = memory.supersededBy !== null;

  const save = async () => {
    try {
      await api.edit(connection, memory.id, draft);
      setMode("read");
      onChanged();
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  const askDelete = async () => {
    try {
      setPreview(await api.previewForget(connection, { ids: [memory.id] }));
      setMode("delete");
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  const confirmDelete = async () => {
    try {
      await api.forget(connection, { ids: [memory.id] });
      onChanged();
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  return (
    <li className={outdated ? "memory outdated" : "memory"}>
      <div className="memory-meta">
        <span>{TYPE_LABELS[memory.type] ?? memory.type}</span>
        <span>{memory.project ?? "All projects"}</span>
        <time>{formatDate(memory.createdAt)}</time>
        {outdated && <span className="flag">Outdated</span>}
      </div>

      {mode === "edit" ? (
        <textarea
          aria-label="Memory text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : (
        <p className="stored">{memory.content}</p>
      )}

      {mode === "read" && (
        <div className="actions">
          <button onClick={() => setMode("edit")}>Edit</button>
          <button onClick={askDelete}>Delete</button>
        </div>
      )}
      {mode === "edit" && (
        <div className="actions">
          <button className="primary" onClick={save}>
            Save changes
          </button>
          <button onClick={() => setMode("read")}>Cancel</button>
        </div>
      )}
      {mode === "delete" && preview && (
        <div className="confirm">
          <p>
            This permanently deletes {countMemories(preview.memories)} and{" "}
            {countEntries(preview.events)}.
          </p>
          <div className="actions">
            <button className="danger" onClick={confirmDelete}>
              Delete permanently
            </button>
            <button onClick={() => setMode("read")}>Keep it</button>
          </div>
        </div>
      )}
      <ErrorNote message={error} />
    </li>
  );
}

function MemoriesView({ connection }: { connection: Connection }) {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [type, setType] = useState("");
  const [includeOutdated, setIncludeOutdated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMemories(await api.list(connection, { type, includeOutdated }));
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [connection, type, includeOutdated]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section>
      <h2>Memories</h2>
      <div className="filters">
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>
            {TYPES.map((value) => (
              <option key={value} value={value}>
                {TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={includeOutdated}
            onChange={(e) => setIncludeOutdated(e.target.checked)}
          />
          Show outdated memories
        </label>
      </div>
      <ErrorNote message={error} />
      {memories?.length === 0 && (
        <p className="empty">
          Nothing is stored for {connection.user}. Memories appear here after an
          agent session ends.
        </p>
      )}
      <ul className="memories">
        {memories?.map((memory) => (
          <MemoryRow
            key={memory.id}
            memory={memory}
            connection={connection}
            onChanged={() => void load()}
          />
        ))}
      </ul>
    </section>
  );
}

function ScoreBar({ score }: { score: Score }) {
  const parts = [
    ["relevance", 0.7 * score.relevance],
    ["recency", 0.15 * score.recency],
    ["importance", 0.15 * score.importance],
  ] as const;
  return (
    <div className="score">
      <div
        className="bar"
        role="img"
        aria-label={`Score ${score.total.toFixed(2)} of 1`}
      >
        {parts.map(([name, value]) => (
          <span
            key={name}
            className={name}
            style={{ width: `${value * 100}%` }}
          />
        ))}
      </div>
      <dl>
        <div>
          <dt>Score</dt>
          <dd>{score.total.toFixed(2)}</dd>
        </div>
        <div>
          <dt>By meaning</dt>
          <dd>{score.vectorRank ? `#${score.vectorRank}` : "No match"}</dd>
        </div>
        <div>
          <dt>By words</dt>
          <dd>{score.textRank ? `#${score.textRank}` : "No match"}</dd>
        </div>
        <div>
          <dt>Newness</dt>
          <dd>{score.recency.toFixed(2)}</dd>
        </div>
        <div>
          <dt>Importance</dt>
          <dd>{score.importance.toFixed(2)}</dd>
        </div>
      </dl>
    </div>
  );
}

function SearchView({ connection }: { connection: Connection }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setResults(await api.search(connection, query));
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  return (
    <section>
      <h2>Search</h2>
      <p className="lead">See what an agent would get, and why.</p>
      <form className="inline" onSubmit={submit}>
        <input
          aria-label="Search memories"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          required
        />
        <button className="primary">Search</button>
      </form>
      <ErrorNote message={error} />
      {results?.length === 0 && (
        <p className="empty">No memories match. Try different words.</p>
      )}
      <ul className="memories">
        {results?.map((result) => (
          <li key={result.id} className="memory">
            <p className="stored">{result.content}</p>
            <ScoreBar score={result.score} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Receipt({ receipt }: { receipt: ForgetReceipt }) {
  return (
    <aside className="receipt" aria-label="Deletion receipt">
      <h3>Deletion receipt</h3>
      <dl>
        <div>
          <dt>Completed</dt>
          <dd>{formatDate(receipt.completedAt)}</dd>
        </div>
        <div>
          <dt>Memories deleted</dt>
          <dd>{receipt.memoriesDeleted}</dd>
        </div>
        <div>
          <dt>Transcript entries deleted</dt>
          <dd>{receipt.eventsDeleted}</dd>
        </div>
      </dl>
      <p className="fingerprint">
        Receipt {receipt.receiptId}
        <br />
        Fingerprint {receipt.targetsSha256}
      </p>
      {receipt.diskScrubPending && (
        <p>
          This is gone from every search and export now. Its bytes leave the
          database files in tonight's cleanup, and from backups when they
          expire.
        </p>
      )}
    </aside>
  );
}

type ForgetMode = "topic" | "dates" | "everything";

function ForgetView({ connection }: { connection: Connection }) {
  const [mode, setMode] = useState<ForgetMode>("topic");
  const [topic, setTopic] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [typedName, setTypedName] = useState("");
  const [preview, setPreview] = useState<ForgetPreview | null>(null);
  const [receipt, setReceipt] = useState<ForgetReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selector = (): ForgetRequest => {
    if (mode === "topic") return { topic };
    if (mode === "everything") return { everything: true };
    return {
      ...(from && { from: new Date(from).toISOString() }),
      ...(to && { to: new Date(to).toISOString() }),
    };
  };

  const changeMode = (next: ForgetMode) => {
    setMode(next);
    setPreview(null);
    setReceipt(null);
    setTypedName("");
  };

  const showPreview = async (event: FormEvent) => {
    event.preventDefault();
    setReceipt(null);
    try {
      setPreview(await api.previewForget(connection, selector()));
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  const forget = async () => {
    try {
      setReceipt(await api.forget(connection, selector()));
      setPreview(null);
      setTypedName("");
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  const nothingFound = preview?.memories === 0 && preview.events === 0;
  const blocked = mode === "everything" && typedName !== connection.user;

  return (
    <section>
      <h2>Forget</h2>
      <p className="lead">
        Erases the memories, the transcripts behind them, and anything built
        from those transcripts. This cannot be undone.
      </p>
      <fieldset className="modes">
        <legend>What to forget</legend>
        {(
          [
            ["topic", "A topic"],
            ["dates", "A date range"],
            ["everything", `Everything about ${connection.user}`],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="check">
            <input
              type="radio"
              name="forget-mode"
              checked={mode === value}
              onChange={() => changeMode(value)}
            />
            {label}
          </label>
        ))}
      </fieldset>

      <form onSubmit={showPreview}>
        {mode === "topic" && (
          <label>
            Topic
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              required
            />
          </label>
        )}
        {mode === "dates" && (
          <div className="filters">
            <label>
              From
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label>
              Up to
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
          </div>
        )}
        <button>Preview what would be deleted</button>
      </form>
      <ErrorNote message={error} />

      {preview && nothingFound && (
        <p className="empty">Nothing matches, so nothing would be deleted.</p>
      )}
      {preview && !nothingFound && (
        <div className="confirm">
          <p>
            This permanently deletes {countMemories(preview.memories)} and{" "}
            {countEntries(preview.events)}.
          </p>
          {mode === "everything" && (
            <label>
              Type {connection.user} to confirm
              <input
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
              />
            </label>
          )}
          <button className="danger" onClick={forget} disabled={blocked}>
            Delete permanently
          </button>
        </div>
      )}
      {receipt && <Receipt receipt={receipt} />}
    </section>
  );
}

function ActivityView({ connection }: { connection: Connection }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.audit(connection).then(setEntries, (cause) => {
      setError(describeError(cause));
    });
  }, [connection]);

  return (
    <section>
      <h2>Activity</h2>
      <p className="lead">
        A record of each change. It holds ids and times, never the text.
      </p>
      <ErrorNote message={error} />
      {entries?.length === 0 && <p className="empty">No activity yet.</p>}
      {entries && entries.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">What happened</th>
              <th scope="col">Items</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{formatDate(entry.ts)}</td>
                <td>{ACTION_LABELS[entry.action] ?? entry.action}</td>
                <td>{entry.targetIds.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ExportView({ connection }: { connection: Connection }) {
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    try {
      const data = await api.exportData(connection);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `memory-export-${connection.user}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  return (
    <section>
      <h2>Export</h2>
      <p className="lead">
        Download everything stored about {connection.user} as a JSON file:
        memories, transcripts and the activity record.
      </p>
      <button className="primary" onClick={download}>
        Download data
      </button>
      <ErrorNote message={error} />
    </section>
  );
}

export function App() {
  const [connection, setConnection] = useState(loadConnection);
  const [view, setView] = useState<View>("Memories");

  const connect = (next: Connection | null) => {
    saveConnection(next);
    setConnection(next);
  };

  if (!connection) return <SignIn onConnect={connect} />;

  return (
    <div className="shell">
      <nav aria-label="Sections">
        <p className="person">{connection.user}</p>
        <ul>
          {VIEWS.map((name) => (
            <li key={name}>
              <button
                aria-current={view === name ? "page" : undefined}
                onClick={() => setView(name)}
              >
                {name}
              </button>
            </li>
          ))}
        </ul>
        <button className="signout" onClick={() => connect(null)}>
          Switch person
        </button>
      </nav>
      <main>
        {view === "Memories" && <MemoriesView connection={connection} />}
        {view === "Search" && <SearchView connection={connection} />}
        {view === "Forget" && <ForgetView connection={connection} />}
        {view === "Activity" && <ActivityView connection={connection} />}
        {view === "Export" && <ExportView connection={connection} />}
      </main>
    </div>
  );
}
