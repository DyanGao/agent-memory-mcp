export interface Connection {
  user: string;
  apiKey: string;
}

export interface Memory {
  id: string;
  type: string;
  content: string;
  importance: number;
  createdAt: string;
  project: string | null;
  supersededBy: string | null;
  validTo: string | null;
}

export interface Score {
  vectorRank: number | null;
  textRank: number | null;
  relevance: number;
  recency: number;
  importance: number;
  total: number;
}

export interface SearchResult extends Memory {
  score: Score;
}

export interface ForgetCandidate {
  id: string;
  content: string;
  similarity: number;
}

export interface ForgetPreview {
  memories: { id: string; content: string }[];
  eventCount: number;
  candidates: ForgetCandidate[];
}

export interface ForgetReceipt {
  receiptId: string;
  completedAt: string;
  memoriesDeleted: number;
  eventsDeleted: number;
  targetsSha256: string;
  diskScrubPending: boolean;
}

export interface AuditEntry {
  id: string;
  action: string;
  actor: string;
  targetIds: string[];
  ts: string;
}

export type ForgetRequest = {
  everything?: boolean;
  ids?: string[];
  topic?: string;
  from?: string;
  to?: string;
};

const MESSAGES: Record<number, string> = {
  401: "That API key was not accepted. Check MEMORY_API_KEY in your .env file.",
  404: "That item no longer exists.",
};

async function request<T>(
  connection: Connection,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${connection.apiKey}`,
      "x-memory-user": connection.user,
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) {
    const fallback = `The server returned HTTP ${response.status}.`;
    throw new Error(MESSAGES[response.status] ?? fallback);
  }
  return response.json() as Promise<T>;
}

export const api = {
  list: async (
    connection: Connection,
    filters: { type: string; includeOutdated: boolean },
  ) => {
    const query = new URLSearchParams({
      limit: "200",
      include_outdated: String(filters.includeOutdated),
      ...(filters.type && { type: filters.type }),
    });
    const { memories } = await request<{ memories: Memory[] }>(
      connection,
      `/v1/memories?${query}`,
    );
    return memories;
  },
  search: async (connection: Connection, query: string) => {
    const { results } = await request<{ results: SearchResult[] }>(
      connection,
      "/v1/search",
      { method: "POST", body: { query } },
    );
    return results;
  },
  edit: (connection: Connection, id: string, content: string) =>
    request(connection, `/v1/memories/${id}`, {
      method: "PATCH",
      body: { content },
    }),
  previewForget: (connection: Connection, selector: ForgetRequest) =>
    request<ForgetPreview>(connection, "/v1/forget", {
      method: "POST",
      body: { ...selector, dry_run: true },
    }),
  forget: (connection: Connection, selector: ForgetRequest) =>
    request<ForgetReceipt>(connection, "/v1/forget", {
      method: "POST",
      body: { ...selector, confirm: true },
    }),
  audit: async (connection: Connection) => {
    const { entries } = await request<{ entries: AuditEntry[] }>(
      connection,
      "/v1/audit",
    );
    return entries;
  },
  exportData: (connection: Connection) =>
    request<unknown>(connection, "/v1/export"),
};
