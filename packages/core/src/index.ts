export { ensureAppRole, withScope } from "./db.js";
export type { Scope } from "./db.js";
export {
  assertEmbedderDimension,
  EMBEDDING_DIMENSION,
  FakeEmbedder,
  OllamaEmbedder,
} from "./embedder.js";
export type { Embedder } from "./embedder.js";
export { migrate, orderMigrations } from "./migrate.js";
export { estimateTokens, packToBudget, scoreCandidate } from "./ranking.js";
export type { Candidate, ScoreBreakdown } from "./ranking.js";
export {
  DEFAULT_TOKEN_BUDGET,
  DEFAULT_TOP_K,
  MEMORY_TYPES,
  MemoryStore,
  SourceForgottenError,
} from "./store.js";
export type {
  Memory,
  MemoryInput,
  MemoryType,
  SearchResult,
  SimilarMemory,
  WriteOptions,
} from "./store.js";
export {
  DISTILLABLE_KINDS,
  EVENT_KINDS,
  eventId,
  getDistillStatus,
  ingestEvents,
  loadDistillableEvents,
  recordDistillOutcome,
  sweepExpired,
} from "./events.js";
export type { EventInput, EventKind, StoredEvent } from "./events.js";
export { MemoryQueue, scopeOf } from "./queue.js";
export type { DistillJob } from "./queue.js";
export { redact } from "./redact.js";
export { executeForget, previewForget, scrubDeletedData } from "./forget.js";
export type {
  ForgetCandidate,
  ForgetPlan,
  ForgetPreview,
  ForgetReceipt,
  ForgetSelector,
} from "./forget.js";
export { exportUserData, readAudit } from "./account.js";
export type { AuditEntry } from "./account.js";
export { startTelemetry, traced } from "./telemetry.js";
