import { app } from "electron";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { WidgetState } from "../../shared/types";

const CHAT_DB_FILENAME = "chat.sqlite";
const DEFAULT_SESSION_TITLE = "New Session";
const TITLE_MAX_LENGTH = 64;

const dbCache = new Map<string, DatabaseSync>();

export interface TokenUsageState {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface PersistedPipSnapshot {
  instanceId: string;
  serverName: string;
  resourceUri: string;
  toolName: string;
  title: string;
  createdAt: number;
  triggeredByTool?: boolean;
  openInBackground?: boolean;
  widgetState?: WidgetState;
}

export interface PersistedPipState {
  pips: PersistedPipSnapshot[];
  pipOrder: string[];
  activePipId: string | null;
}

export interface ChatSessionState {
  streamedMessages: unknown[];
  injectedMessages: unknown[];
  messageOrder: Record<string, number>;
  nextOrder: number;
  tokenUsage: TokenUsageState;
  pipState: PersistedPipState;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  isAutoTitle: boolean;
  isPinned: boolean;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  message_count: number;
}

export interface ChatSessionWithState {
  summary: ChatSessionSummary;
  state: ChatSessionState;
}

const createDefaultPipState = (): PersistedPipState => ({
  pips: [],
  pipOrder: [],
  activePipId: null,
});

const DEFAULT_PIP_STATE_JSON = JSON.stringify(createDefaultPipState());

const DEFAULT_STATE: ChatSessionState = {
  streamedMessages: [],
  injectedMessages: [],
  messageOrder: {},
  nextOrder: 0,
  tokenUsage: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  },
  pipState: createDefaultPipState(),
};

const nowMs = (): number => Date.now();

const toIso = (ms: number): string => new Date(ms).toISOString();

const normalizeManualTitle = (value: string): string | null => {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, TITLE_MAX_LENGTH);
};

const getProjectDir = (projectId: string): string => {
  return path.join(app.getPath("userData"), "projects", projectId);
};

const getDbPath = (projectId: string): string => {
  return path.join(getProjectDir(projectId), CHAT_DB_FILENAME);
};

const ensureProjectDir = (projectId: string): void => {
  const projectDir = getProjectDir(projectId);
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }
};

const parseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const normalizeTokenUsage = (value: unknown): TokenUsageState => {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_STATE.tokenUsage };
  }
  const usage = value as Partial<TokenUsageState>;
  return {
    inputTokens: Number.isFinite(usage.inputTokens) ? Number(usage.inputTokens) : 0,
    outputTokens: Number.isFinite(usage.outputTokens) ? Number(usage.outputTokens) : 0,
    totalTokens: Number.isFinite(usage.totalTokens) ? Number(usage.totalTokens) : 0,
  };
};

const normalizeMessageOrder = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== "object") {
    return {};
  }
  const raw = value as Record<string, unknown>;
  const normalized: Record<string, number> = {};
  for (const [key, order] of Object.entries(raw)) {
    if (Number.isFinite(order)) {
      normalized[key] = Number(order);
    }
  }
  return normalized;
};

const normalizeWidgetState = (value: unknown): WidgetState | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const next: WidgetState = {};

  if (
    raw.modelContent === null ||
    typeof raw.modelContent === "string" ||
    (typeof raw.modelContent === "object" && !Array.isArray(raw.modelContent))
  ) {
    next.modelContent = raw.modelContent as WidgetState["modelContent"];
  }

  if (
    raw.privateContent === null ||
    (typeof raw.privateContent === "object" && !Array.isArray(raw.privateContent))
  ) {
    next.privateContent = raw.privateContent as WidgetState["privateContent"];
  }

  if (Array.isArray(raw.imageIds)) {
    next.imageIds = raw.imageIds.filter((id): id is string => typeof id === "string");
  }

  if (
    next.modelContent === undefined &&
    next.privateContent === undefined &&
    next.imageIds === undefined
  ) {
    return undefined;
  }

  return next;
};

const normalizePipSnapshot = (value: unknown): PersistedPipSnapshot | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Record<string, unknown>;
  if (
    typeof raw.instanceId !== "string" ||
    typeof raw.serverName !== "string" ||
    typeof raw.resourceUri !== "string" ||
    typeof raw.toolName !== "string" ||
    typeof raw.title !== "string"
  ) {
    return null;
  }

  if (
    raw.instanceId.length === 0 ||
    raw.serverName.length === 0 ||
    raw.resourceUri.length === 0
  ) {
    return null;
  }

  const snapshot: PersistedPipSnapshot = {
    instanceId: raw.instanceId,
    serverName: raw.serverName,
    resourceUri: raw.resourceUri,
    toolName: raw.toolName,
    title: raw.title,
    createdAt:
      typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
        ? Number(raw.createdAt)
        : nowMs(),
  };

  if (typeof raw.triggeredByTool === "boolean") {
    snapshot.triggeredByTool = raw.triggeredByTool;
  }

  if (typeof raw.openInBackground === "boolean") {
    snapshot.openInBackground = raw.openInBackground;
  }

  const widgetState = normalizeWidgetState(raw.widgetState);
  if (widgetState) {
    snapshot.widgetState = widgetState;
  }

  return snapshot;
};

const normalizePipState = (value: unknown): PersistedPipState => {
  if (!value || typeof value !== "object") {
    return createDefaultPipState();
  }

  const raw = value as {
    pips?: unknown;
    pipOrder?: unknown;
    activePipId?: unknown;
  };

  const pips = Array.isArray(raw.pips)
    ? raw.pips
        .map(normalizePipSnapshot)
        .filter((pip): pip is PersistedPipSnapshot => !!pip)
    : [];

  const pipIds = new Set(pips.map((pip) => pip.instanceId));
  const pipOrder: string[] = [];
  const pushPipOrder = (id: string) => {
    if (!pipIds.has(id)) return;
    if (pipOrder.includes(id)) return;
    pipOrder.push(id);
  };

  if (Array.isArray(raw.pipOrder)) {
    for (const value of raw.pipOrder) {
      if (typeof value === "string") {
        pushPipOrder(value);
      }
    }
  }

  for (const pip of pips) {
    pushPipOrder(pip.instanceId);
  }

  const activePipId =
    typeof raw.activePipId === "string" && pipIds.has(raw.activePipId)
      ? raw.activePipId
      : null;

  return {
    pips,
    pipOrder,
    activePipId,
  };
};

const normalizeState = (state: ChatSessionState): ChatSessionState => {
  return {
    streamedMessages: Array.isArray(state.streamedMessages) ? state.streamedMessages : [],
    injectedMessages: Array.isArray(state.injectedMessages) ? state.injectedMessages : [],
    messageOrder: normalizeMessageOrder(state.messageOrder),
    nextOrder: Number.isFinite(state.nextOrder) ? Number(state.nextOrder) : 0,
    tokenUsage: normalizeTokenUsage(state.tokenUsage),
    pipState: normalizePipState(state.pipState),
  };
};

const mapSummaryRow = (row: {
  id: string;
  title: string;
  is_auto_title: number;
  is_pinned: number;
  created_at: number;
  updated_at: number;
  last_message_at: number | null;
  message_count: number;
}): ChatSessionSummary => {
  return {
    id: row.id,
    title: row.title,
    isAutoTitle: row.is_auto_title === 1,
    isPinned: row.is_pinned === 1,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    last_message_at: row.last_message_at ? toIso(row.last_message_at) : null,
    message_count: row.message_count,
  };
};

const extractFirstUserMessage = (messages: unknown[]): string | null => {
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const msg = message as { role?: string; parts?: unknown[] };
    if (msg.role !== "user" || !Array.isArray(msg.parts)) continue;
    for (const part of msg.parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as { type?: string; text?: string };
      if (p.type === "text" && typeof p.text === "string") {
        const trimmed = p.text.trim().replace(/\s+/g, " ");
        if (trimmed.length > 0) {
          return trimmed.slice(0, TITLE_MAX_LENGTH);
        }
      }
    }
  }
  return null;
};

const getDb = (projectId: string): DatabaseSync => {
  const cached = dbCache.get(projectId);
  if (cached) {
    return cached;
  }

  ensureProjectDir(projectId);

  const db = new DatabaseSync(getDbPath(projectId));
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      is_auto_title INTEGER NOT NULL DEFAULT 1,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_message_at INTEGER,
      message_count INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_session_state (
      session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
      streamed_messages TEXT NOT NULL,
      injected_messages TEXT NOT NULL,
      message_order_json TEXT NOT NULL,
      next_order INTEGER NOT NULL DEFAULT 0,
      token_usage_json TEXT NOT NULL,
      pip_state_json TEXT NOT NULL DEFAULT '${DEFAULT_PIP_STATE_JSON.replace(/'/g, "''")}',
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated_at
    ON chat_sessions(updated_at DESC)
  `);

  const sessionColumns = db.prepare("PRAGMA table_info(chat_sessions)").all() as Array<{
    name: string;
  }>;
  const hasPinnedColumn = sessionColumns.some((column) => column.name === "is_pinned");
  if (!hasPinnedColumn) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0");
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_pinned_updated
    ON chat_sessions(is_pinned DESC, updated_at DESC)
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_single_active
    ON chat_sessions(is_active)
    WHERE is_active = 1
  `);

  const sessionStateColumns = db.prepare("PRAGMA table_info(chat_session_state)").all() as Array<{
    name: string;
  }>;
  const hasPipStateColumn = sessionStateColumns.some((column) => column.name === "pip_state_json");
  if (!hasPipStateColumn) {
    db.exec(
      `ALTER TABLE chat_session_state ADD COLUMN pip_state_json TEXT NOT NULL DEFAULT '${DEFAULT_PIP_STATE_JSON.replace(/'/g, "''")}'`
    );
  }

  dbCache.set(projectId, db);
  return db;
};

const insertSession = (db: DatabaseSync, sessionId: string, active: boolean): void => {
  const ts = nowMs();
  const insertSummary = db.prepare(`
    INSERT INTO chat_sessions (
      id,
      title,
      is_auto_title,
      created_at,
      updated_at,
      last_message_at,
      message_count,
      is_active
    ) VALUES (?, ?, 1, ?, ?, NULL, 0, ?)
  `);
  insertSummary.run(sessionId, DEFAULT_SESSION_TITLE, ts, ts, active ? 1 : 0);

  const insertState = db.prepare(`
    INSERT INTO chat_session_state (
      session_id,
      streamed_messages,
      injected_messages,
      message_order_json,
      next_order,
      token_usage_json,
      pip_state_json,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertState.run(
    sessionId,
    JSON.stringify(DEFAULT_STATE.streamedMessages),
    JSON.stringify(DEFAULT_STATE.injectedMessages),
    JSON.stringify(DEFAULT_STATE.messageOrder),
    DEFAULT_STATE.nextOrder,
    JSON.stringify(DEFAULT_STATE.tokenUsage),
    JSON.stringify(DEFAULT_STATE.pipState),
    ts
  );
};

const ensureStateRow = (db: DatabaseSync, sessionId: string): void => {
  const existsStmt = db.prepare(
    "SELECT session_id FROM chat_session_state WHERE session_id = ? LIMIT 1"
  );
  const row = existsStmt.get(sessionId) as { session_id: string } | undefined;
  if (row) {
    return;
  }

  const ts = nowMs();
  const insertState = db.prepare(`
    INSERT INTO chat_session_state (
      session_id,
      streamed_messages,
      injected_messages,
      message_order_json,
      next_order,
      token_usage_json,
      pip_state_json,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertState.run(
    sessionId,
    JSON.stringify(DEFAULT_STATE.streamedMessages),
    JSON.stringify(DEFAULT_STATE.injectedMessages),
    JSON.stringify(DEFAULT_STATE.messageOrder),
    DEFAULT_STATE.nextOrder,
    JSON.stringify(DEFAULT_STATE.tokenUsage),
    JSON.stringify(DEFAULT_STATE.pipState),
    ts
  );
};

const ensureInitialSession = (db: DatabaseSync): void => {
  const countStmt = db.prepare("SELECT COUNT(*) AS count FROM chat_sessions");
  const countRow = countStmt.get() as { count: number };
  if (countRow.count > 0) {
    return;
  }

  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    insertSession(db, crypto.randomUUID(), true);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

export const listSessions = (projectId: string): ChatSessionSummary[] => {
  const db = getDb(projectId);
  ensureInitialSession(db);

  const stmt = db.prepare(`
    SELECT
      id,
      title,
      is_auto_title,
      is_pinned,
      created_at,
      updated_at,
      last_message_at,
      message_count
    FROM chat_sessions
    ORDER BY is_pinned DESC, updated_at DESC
  `);

  const rows = stmt.all() as Array<{
    id: string;
    title: string;
    is_auto_title: number;
    is_pinned: number;
    created_at: number;
    updated_at: number;
    last_message_at: number | null;
    message_count: number;
  }>;

  return rows.map(mapSummaryRow);
};

const getSessionWithStateById = (
  db: DatabaseSync,
  sessionId: string
): ChatSessionWithState | null => {
  const stmt = db.prepare(`
    SELECT
      s.id,
      s.title,
      s.is_auto_title,
      s.is_pinned,
      s.created_at,
      s.updated_at,
      s.last_message_at,
      s.message_count,
      st.streamed_messages,
      st.injected_messages,
      st.message_order_json,
      st.next_order,
      st.token_usage_json,
      st.pip_state_json
    FROM chat_sessions s
    LEFT JOIN chat_session_state st ON st.session_id = s.id
    WHERE s.id = ?
    LIMIT 1
  `);

  const row = stmt.get(sessionId) as
    | {
        id: string;
        title: string;
        is_auto_title: number;
        is_pinned: number;
        created_at: number;
        updated_at: number;
        last_message_at: number | null;
        message_count: number;
        streamed_messages: string | null;
        injected_messages: string | null;
        message_order_json: string | null;
        next_order: number | null;
        token_usage_json: string | null;
        pip_state_json: string | null;
      }
    | undefined;

  if (!row) {
    return null;
  }

  ensureStateRow(db, row.id);

  const state = normalizeState({
    streamedMessages: row.streamed_messages ? parseJson<unknown[]>(row.streamed_messages, []) : [],
    injectedMessages: row.injected_messages ? parseJson<unknown[]>(row.injected_messages, []) : [],
    messageOrder: row.message_order_json
      ? parseJson<Record<string, number>>(row.message_order_json, {})
      : {},
    nextOrder: row.next_order ?? 0,
    tokenUsage: row.token_usage_json
      ? parseJson<TokenUsageState>(row.token_usage_json, DEFAULT_STATE.tokenUsage)
      : DEFAULT_STATE.tokenUsage,
    pipState: row.pip_state_json
      ? parseJson<PersistedPipState>(row.pip_state_json, createDefaultPipState())
      : createDefaultPipState(),
  });

  return {
    summary: mapSummaryRow({
      id: row.id,
      title: row.title,
      is_auto_title: row.is_auto_title,
      is_pinned: row.is_pinned,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_message_at: row.last_message_at,
      message_count: row.message_count,
    }),
    state,
  };
};

export const getActiveSession = (
  projectId: string
): { session: ChatSessionWithState; sessions: ChatSessionSummary[] } => {
  const db = getDb(projectId);
  ensureInitialSession(db);

  let activeStmt = db.prepare(
    "SELECT id FROM chat_sessions WHERE is_active = 1 LIMIT 1"
  );
  let activeRow = activeStmt.get() as { id: string } | undefined;

  if (!activeRow) {
    const newestStmt = db.prepare(
      "SELECT id FROM chat_sessions ORDER BY updated_at DESC LIMIT 1"
    );
    const newest = newestStmt.get() as { id: string } | undefined;
    if (!newest) {
      throw new Error("Failed to find or create a chat session");
    }

    db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      db.exec("UPDATE chat_sessions SET is_active = 0 WHERE is_active = 1");
      const setActiveStmt = db.prepare(
        "UPDATE chat_sessions SET is_active = 1 WHERE id = ?"
      );
      setActiveStmt.run(newest.id);
      db.exec("COMMIT");
      activeRow = { id: newest.id };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const session = getSessionWithStateById(db, activeRow.id);
  if (!session) {
    throw new Error("Failed to load active chat session");
  }

  return {
    session,
    sessions: listSessions(projectId),
  };
};

export const createSession = (
  projectId: string
): { session: ChatSessionWithState; sessions: ChatSessionSummary[] } => {
  const db = getDb(projectId);
  ensureInitialSession(db);

  const sessionId = crypto.randomUUID();
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    db.exec("UPDATE chat_sessions SET is_active = 0 WHERE is_active = 1");
    insertSession(db, sessionId, true);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const session = getSessionWithStateById(db, sessionId);
  if (!session) {
    throw new Error("Failed to create chat session");
  }

  return {
    session,
    sessions: listSessions(projectId),
  };
};

export const switchSession = (
  projectId: string,
  sessionId: string
): { session: ChatSessionWithState; sessions: ChatSessionSummary[] } => {
  const db = getDb(projectId);
  ensureInitialSession(db);

  const existsStmt = db.prepare("SELECT id FROM chat_sessions WHERE id = ? LIMIT 1");
  const exists = existsStmt.get(sessionId) as { id: string } | undefined;
  if (!exists) {
    throw new Error("Chat session not found");
  }

  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    db.exec("UPDATE chat_sessions SET is_active = 0 WHERE is_active = 1");
    const setActiveStmt = db.prepare(
      "UPDATE chat_sessions SET is_active = 1, updated_at = ? WHERE id = ?"
    );
    setActiveStmt.run(nowMs(), sessionId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const session = getSessionWithStateById(db, sessionId);
  if (!session) {
    throw new Error("Failed to load selected chat session");
  }

  return {
    session,
    sessions: listSessions(projectId),
  };
};

export const saveSessionState = (
  projectId: string,
  sessionId: string,
  state: ChatSessionState
): { session: ChatSessionSummary; sessions: ChatSessionSummary[] } => {
  const db = getDb(projectId);
  ensureInitialSession(db);

  const normalized = normalizeState(state);
  const ts = nowMs();
  const snippet = extractFirstUserMessage(normalized.streamedMessages);
  const lastMessageAt = normalized.streamedMessages.length > 0 ? ts : null;
  const messageCount = normalized.streamedMessages.length;

  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    ensureStateRow(db, sessionId);

    const upsertState = db.prepare(`
      INSERT OR REPLACE INTO chat_session_state (
        session_id,
        streamed_messages,
        injected_messages,
        message_order_json,
        next_order,
        token_usage_json,
        pip_state_json,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    upsertState.run(
      sessionId,
      JSON.stringify(normalized.streamedMessages),
      JSON.stringify(normalized.injectedMessages),
      JSON.stringify(normalized.messageOrder),
      normalized.nextOrder,
      JSON.stringify(normalized.tokenUsage),
      JSON.stringify(normalized.pipState),
      ts
    );

    const updateSummary = db.prepare(`
      UPDATE chat_sessions
      SET
        updated_at = ?,
        last_message_at = ?,
        message_count = ?,
        title = CASE
          WHEN is_auto_title = 1 AND ? IS NOT NULL AND length(?) > 0
            THEN ?
          ELSE title
        END,
        is_auto_title = CASE
          WHEN is_auto_title = 1 AND ? IS NOT NULL AND length(?) > 0
            THEN 0
          ELSE is_auto_title
        END
      WHERE id = ?
    `);

    updateSummary.run(
      ts,
      lastMessageAt,
      messageCount,
      snippet,
      snippet,
      snippet,
      snippet,
      snippet,
      sessionId
    );

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const session = getSessionWithStateById(db, sessionId);
  if (!session) {
    throw new Error("Failed to load updated chat session");
  }

  return {
    session: session.summary,
    sessions: listSessions(projectId),
  };
};

export const renameSession = (
  projectId: string,
  sessionId: string,
  title: string
): { session: ChatSessionSummary; sessions: ChatSessionSummary[] } => {
  const db = getDb(projectId);
  ensureInitialSession(db);

  const normalizedTitle = normalizeManualTitle(title);
  if (!normalizedTitle) {
    throw new Error("Session title is required");
  }

  const updateStmt = db.prepare(`
    UPDATE chat_sessions
    SET title = ?, is_auto_title = 0
    WHERE id = ?
  `);
  const result = updateStmt.run(normalizedTitle, sessionId);
  if (result.changes === 0) {
    throw new Error("Chat session not found");
  }

  const session = getSessionWithStateById(db, sessionId);
  if (!session) {
    throw new Error("Failed to load updated chat session");
  }

  return {
    session: session.summary,
    sessions: listSessions(projectId),
  };
};

export const setSessionPinned = (
  projectId: string,
  sessionId: string,
  pinned: boolean
): { session: ChatSessionSummary; sessions: ChatSessionSummary[] } => {
  const db = getDb(projectId);
  ensureInitialSession(db);

  const updateStmt = db.prepare(`
    UPDATE chat_sessions
    SET is_pinned = ?
    WHERE id = ?
  `);
  const result = updateStmt.run(pinned ? 1 : 0, sessionId);
  if (result.changes === 0) {
    throw new Error("Chat session not found");
  }

  const session = getSessionWithStateById(db, sessionId);
  if (!session) {
    throw new Error("Failed to load updated chat session");
  }

  return {
    session: session.summary,
    sessions: listSessions(projectId),
  };
};
