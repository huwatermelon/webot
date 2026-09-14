import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function json(value, fallback = null) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function now() {
  return Date.now();
}

function caseIdFor(message) {
  const conversation =
    message.conversationId ||
    `${message.chatType || "private"}:${message.chatId}`;
  return `wechat:${message.sourceId || "default"}:${conversation}`;
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

export class CaseStore {
  constructor(file) {
    this.file = path.resolve(file);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.file);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        case_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        direction TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        text TEXT NOT NULL,
        message_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(source_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS messages_case_time
        ON messages(case_id, timestamp, id);
      CREATE TABLE IF NOT EXISTS cases (
        case_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        unread_count INTEGER NOT NULL DEFAULT 0,
        last_message_id INTEGER,
        last_message_at INTEGER NOT NULL,
        last_run_at INTEGER,
        last_error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cases_updated ON cases(updated_at DESC);
      CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY,
        case_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        outbound_json TEXT NOT NULL DEFAULT '',
        FOREIGN KEY(case_id) REFERENCES cases(case_id)
      );
      CREATE INDEX IF NOT EXISTS drafts_case_time
        ON drafts(case_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS worker_sessions (
        case_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        run_count INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER,
        finished_at INTEGER,
        last_error TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(case_id) REFERENCES cases(case_id)
      );
      CREATE TABLE IF NOT EXISTS progress (
        id INTEGER PRIMARY KEY,
        case_id TEXT NOT NULL,
        run_count INTEGER NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(case_id) REFERENCES cases(case_id)
      );
      CREATE INDEX IF NOT EXISTS progress_case_time
        ON progress(case_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS runtime_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    ensureColumn(
      this.db,
      "worker_sessions",
      "codex_session_id",
      "TEXT NOT NULL DEFAULT ''",
    );
    ensureColumn(
      this.db,
      "worker_sessions",
      "model",
      "TEXT NOT NULL DEFAULT ''",
    );
    ensureColumn(
      this.db,
      "worker_sessions",
      "request_count",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
      this.db,
      "worker_sessions",
      "input_tokens",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
      this.db,
      "worker_sessions",
      "cached_input_tokens",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
      this.db,
      "worker_sessions",
      "cache_write_input_tokens",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
      this.db,
      "worker_sessions",
      "output_tokens",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
      this.db,
      "worker_sessions",
      "reasoning_output_tokens",
      "INTEGER NOT NULL DEFAULT 0",
    );
    const addedProcessedMessageCursor = ensureColumn(
      this.db,
      "worker_sessions",
      "last_processed_message_id",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
      this.db,
      "worker_sessions",
      "input_cutoff_message_id",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
      this.db,
      "drafts",
      "trigger_message_id",
      "INTEGER",
    );
    ensureColumn(
      this.db,
      "drafts",
      "input_cutoff_message_id",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
      this.db,
      "drafts",
      "artifacts_json",
      "TEXT NOT NULL DEFAULT '[]'",
    );
    if (addedProcessedMessageCursor) {
      this.db.exec(`
        UPDATE worker_sessions
        SET last_processed_message_id=COALESCE(
          (SELECT last_message_id FROM cases
           WHERE cases.case_id=worker_sessions.case_id),
          0
        )
      `);
    }
    const recoveredAt = now();
    this.db.exec(`
      INSERT INTO progress(case_id, run_count, level, message, created_at)
      SELECT case_id, run_count, 'warn',
        'Webot 重启中断了 worker，Case 已恢复为待处理',
        ${recoveredAt}
      FROM worker_sessions
      WHERE status='running';
      UPDATE worker_sessions
      SET status='stopped', last_error='Webot restarted during worker run',
          finished_at=${recoveredAt}, updated_at=${recoveredAt}
      WHERE status='running';
      UPDATE cases
      SET status='new', last_error='', updated_at=${recoveredAt}
      WHERE status='running';
    `);
  }

  close() {
    this.db.close();
  }

  runtimeSetting(key, fallback = "") {
    const row = this.db
      .prepare("SELECT value FROM runtime_settings WHERE key=?")
      .get(String(key));
    return row ? String(row.value) : fallback;
  }

  setRuntimeSetting(key, value) {
    this.db.prepare(`
      INSERT INTO runtime_settings(key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE
      SET value=excluded.value, updated_at=excluded.updated_at
    `).run(String(key), String(value), now());
  }

  deleteRuntimeSetting(key) {
    this.db.prepare("DELETE FROM runtime_settings WHERE key=?").run(String(key));
  }

  ingest(message, text = message.text) {
    const caseId = caseIdFor(message);
    const createdAt = now();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO messages(
        case_id, source_id, message_id, timestamp, direction,
        sender_id, sender_name, chat_type, chat_id, text,
        message_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      caseId,
      String(message.sourceId || "default"),
      String(message.messageId),
      Number(message.timestamp || createdAt),
      String(message.direction || "incoming"),
      String(message.senderId || ""),
      String(message.senderName || ""),
      String(message.chatType || "private"),
      String(message.chatId || ""),
      String(text || ""),
      JSON.stringify({ ...message, text: String(text || "") }),
      createdAt,
    );
    if (!result.changes) return { inserted: false, caseId };

    const messageRow = Number(result.lastInsertRowid);
    const title =
      String(message.senderName || "").trim() ||
      String(message.chatId || message.senderId || "微信会话");
    this.db.prepare(`
      INSERT INTO cases(
        case_id, source_id, source_name, chat_type, chat_id, title,
        status, unread_count, last_message_id, last_message_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'new', 1, ?, ?, ?, ?)
      ON CONFLICT(case_id) DO UPDATE SET
        source_name=excluded.source_name,
        title=excluded.title,
        status='new',
        unread_count=cases.unread_count + 1,
        last_message_id=excluded.last_message_id,
        last_message_at=excluded.last_message_at,
        last_error='',
        updated_at=excluded.updated_at
    `).run(
      caseId,
      String(message.sourceId || "default"),
      String(message.sourceName || message.sourceId || "微信账号"),
      String(message.chatType || "private"),
      String(message.chatId || ""),
      title,
      messageRow,
      Number(message.timestamp || createdAt),
      createdAt,
      createdAt,
    );
    return { inserted: true, caseId, messageRow };
  }

  listCases(limit = 100) {
    return this.db.prepare(`
      SELECT c.*,
        (SELECT text FROM messages WHERE id=c.last_message_id) AS last_message,
        (SELECT COUNT(*) FROM drafts d WHERE d.case_id=c.case_id) AS draft_count,
        (SELECT status FROM worker_sessions w WHERE w.case_id=c.case_id) AS worker_status
      FROM cases c
      ORDER BY c.updated_at DESC
      LIMIT ?
    `).all(Math.min(Math.max(Number(limit) || 100, 1), 500));
  }

  caseRow(caseId) {
    return this.db.prepare("SELECT * FROM cases WHERE case_id=?").get(caseId);
  }

  pendingCaseIds(limit = 500) {
    return this.db.prepare(`
      SELECT case_id FROM cases
      WHERE status='new'
      ORDER BY updated_at ASC
      LIMIT ?
    `).all(Math.min(Math.max(Number(limit) || 500, 1), 500))
      .map((row) => row.case_id);
  }

  messages(caseId, limit = 200) {
    return this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages
        WHERE case_id=?
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
      ) ORDER BY timestamp ASC, id ASC
    `).all(caseId, Math.min(Math.max(Number(limit) || 200, 1), 1000))
      .map((row) => ({ ...row, message: json(row.message_json, {}) }));
  }

  latestMessage(caseId) {
    const row = this.db.prepare(`
      SELECT * FROM messages
      WHERE case_id=?
      ORDER BY timestamp DESC, id DESC
      LIMIT 1
    `).get(caseId);
    return row ? { ...row, message: json(row.message_json, {}) } : null;
  }

  messageByRowId(caseId, messageRowId) {
    const row = this.db.prepare(`
      SELECT * FROM messages
      WHERE case_id=? AND id=?
    `).get(caseId, Number(messageRowId));
    return row ? { ...row, message: json(row.message_json, {}) } : null;
  }

  updateMessageText(caseId, messageRowId, text) {
    const row = this.messageByRowId(caseId, messageRowId);
    if (!row) return false;
    const message = { ...row.message, text: String(text || "") };
    this.db.prepare(`
      UPDATE messages SET text=?, message_json=?
      WHERE case_id=? AND id=?
    `).run(
      String(text || ""),
      JSON.stringify(message),
      caseId,
      Number(messageRowId),
    );
    return true;
  }

  pendingMessages(caseId, afterMessageId = 0) {
    return this.db.prepare(`
      SELECT * FROM messages
      WHERE case_id=? AND id>?
      ORDER BY id ASC
    `).all(caseId, Number(afterMessageId || 0))
      .map((row) => ({ ...row, message: json(row.message_json, {}) }));
  }

  drafts(caseId, limit = 50) {
    return this.db.prepare(`
      SELECT * FROM drafts
      WHERE case_id=?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(caseId, Math.min(Math.max(Number(limit) || 50, 1), 200))
      .map((row) => ({
        ...row,
        artifacts: json(row.artifacts_json, []),
        outbound: json(row.outbound_json, null),
      }));
  }

  progress(caseId, limit = 100) {
    return this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM progress
        WHERE case_id=?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) ORDER BY created_at ASC, id ASC
    `).all(caseId, Math.min(Math.max(Number(limit) || 100, 1), 500));
  }

  detail(caseId) {
    const value = this.caseRow(caseId);
    if (!value) return null;
    return {
      ...value,
      messages: this.messages(caseId),
      drafts: this.drafts(caseId),
      progress: this.progress(caseId),
      workerSession: this.db
        .prepare("SELECT * FROM worker_sessions WHERE case_id=?")
        .get(caseId) || null,
    };
  }

  startRun(caseId, inputCutoffMessageId = 0) {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO worker_sessions(
        case_id, status, run_count, started_at, last_error,
        input_cutoff_message_id, updated_at
      ) VALUES (?, 'running', 1, ?, '', ?, ?)
      ON CONFLICT(case_id) DO UPDATE SET
        status='running',
        run_count=worker_sessions.run_count + 1,
        started_at=excluded.started_at,
        finished_at=NULL,
        last_error='',
        input_cutoff_message_id=excluded.input_cutoff_message_id,
        updated_at=excluded.updated_at
    `).run(
      caseId,
      timestamp,
      Number(inputCutoffMessageId || 0),
      timestamp,
    );
    this.db.prepare(`
      UPDATE cases SET status='running', last_run_at=?, last_error='',
        updated_at=? WHERE case_id=?
    `).run(timestamp, timestamp, caseId);
    return this.db
      .prepare("SELECT * FROM worker_sessions WHERE case_id=?")
      .get(caseId);
  }

  workerSession(caseId) {
    return this.db
      .prepare("SELECT * FROM worker_sessions WHERE case_id=?")
      .get(caseId) || null;
  }

  recordProviderResult(caseId, result = {}) {
    const usage = result.usage || {};
    this.db.prepare(`
      UPDATE worker_sessions SET
        codex_session_id=CASE
          WHEN ?!='' THEN ?
          ELSE codex_session_id
        END,
        model=CASE WHEN ?!='' THEN ? ELSE model END,
        request_count=request_count + 1,
        input_tokens=input_tokens + ?,
        cached_input_tokens=cached_input_tokens + ?,
        cache_write_input_tokens=cache_write_input_tokens + ?,
        output_tokens=output_tokens + ?,
        reasoning_output_tokens=reasoning_output_tokens + ?,
        updated_at=?
      WHERE case_id=?
    `).run(
      String(result.sessionId || ""),
      String(result.sessionId || ""),
      String(result.model || ""),
      String(result.model || ""),
      Number(usage.inputTokens || 0),
      Number(usage.cachedInputTokens || 0),
      Number(usage.cacheWriteInputTokens || 0),
      Number(usage.outputTokens || 0),
      Number(usage.reasoningOutputTokens || 0),
      now(),
      caseId,
    );
  }

  resetCodexSession(caseId) {
    const session = this.workerSession(caseId);
    if (!session) return false;
    this.db.prepare(`
      UPDATE worker_sessions SET codex_session_id='', updated_at=?
      WHERE case_id=?
    `).run(now(), caseId);
    this.addProgress(caseId, session.run_count, "Codex session 已重置");
    return true;
  }

  markControlHandled(caseId, messageRowId) {
    const timestamp = now();
    const messageId = Number(messageRowId || 0);
    this.db.prepare(`
      INSERT INTO worker_sessions(
        case_id, status, run_count, finished_at, last_error,
        last_processed_message_id, input_cutoff_message_id, updated_at
      ) VALUES (?, 'draft_ready', 0, ?, '', ?, ?, ?)
      ON CONFLICT(case_id) DO UPDATE SET
        status='draft_ready',
        finished_at=excluded.finished_at,
        last_error='',
        last_processed_message_id=MAX(
          worker_sessions.last_processed_message_id,
          excluded.last_processed_message_id
        ),
        input_cutoff_message_id=MAX(
          worker_sessions.input_cutoff_message_id,
          excluded.input_cutoff_message_id
        ),
        updated_at=excluded.updated_at
    `).run(caseId, timestamp, messageId, messageId, timestamp);
  }

  addProgress(caseId, runCount, message, level = "info") {
    this.db.prepare(`
      INSERT INTO progress(case_id, run_count, level, message, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(caseId, Number(runCount || 0), level, String(message), now());
  }

  addDraft(caseId, text, model = "", options = {}) {
    const timestamp = now();
    const triggerMessageId = Number(options.triggerMessageId || 0);
    const inputCutoffMessageId = Number(options.inputCutoffMessageId || 0);
    const result = this.db.prepare(`
      INSERT INTO drafts(
        case_id, text, status, model, trigger_message_id,
        input_cutoff_message_id, artifacts_json, created_at
      )
      VALUES (?, ?, 'draft', ?, ?, ?, ?, ?)
    `).run(
      caseId,
      String(text),
      String(model || ""),
      triggerMessageId || null,
      inputCutoffMessageId,
      JSON.stringify(options.artifacts || []),
      timestamp,
    );
    this.db.prepare(`
      UPDATE cases SET
        status=CASE
          WHEN last_message_id>? THEN 'new'
          ELSE 'draft_ready'
        END,
        unread_count=CASE WHEN last_message_id>? THEN unread_count ELSE 0 END,
        updated_at=? WHERE case_id=?
    `).run(inputCutoffMessageId, inputCutoffMessageId, timestamp, caseId);
    return Number(result.lastInsertRowid);
  }

  finishRun(
    caseId,
    status = "draft_ready",
    error = "",
    processedThroughMessageId = 0,
  ) {
    const timestamp = now();
    const processed = Number(processedThroughMessageId || 0);
    this.db.prepare(`
      UPDATE worker_sessions
      SET status=?, finished_at=?, last_error=?,
        last_processed_message_id=CASE
          WHEN ?>last_processed_message_id THEN ?
          ELSE last_processed_message_id
        END,
        updated_at=?
      WHERE case_id=?
    `).run(
      status,
      timestamp,
      String(error || ""),
      processed,
      processed,
      timestamp,
      caseId,
    );
    this.db.prepare(`
      UPDATE cases SET
        status=CASE
          WHEN ?>0 AND last_message_id>? THEN 'new'
          ELSE ?
        END,
        last_error=?,
        updated_at=?
      WHERE case_id=?
    `).run(
      processed,
      processed,
      status,
      String(error || ""),
      timestamp,
      caseId,
    );
  }

  markSent(caseId, draftId, outbound) {
    const timestamp = now();
    this.db.prepare(`
      UPDATE drafts SET status='sent', sent_at=?, outbound_json=?
      WHERE id=? AND case_id=?
    `).run(timestamp, JSON.stringify(outbound || {}), Number(draftId), caseId);
    this.db.prepare(`
      UPDATE cases SET
        status=CASE
          WHEN last_message_id>(
            SELECT input_cutoff_message_id FROM drafts WHERE id=?
          ) THEN 'new'
          ELSE 'replied'
        END,
        unread_count=CASE
          WHEN last_message_id>(
            SELECT input_cutoff_message_id FROM drafts WHERE id=?
          ) THEN unread_count
          ELSE 0
        END,
        last_error='',
        updated_at=?
      WHERE case_id=?
    `).run(Number(draftId), Number(draftId), timestamp, caseId);
  }

  draft(caseId, draftId) {
    const row = this.db.prepare(`
      SELECT * FROM drafts WHERE case_id=? AND id=?
    `).get(caseId, Number(draftId));
    return row
      ? {
          ...row,
          artifacts: json(row.artifacts_json, []),
          outbound: json(row.outbound_json, null),
        }
      : null;
  }

  stats() {
    const summary = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(status='new') AS new_count,
        SUM(status='running') AS running_count,
        SUM(status='draft_ready') AS draft_count,
        SUM(status='replied') AS replied_count,
        SUM(status='failed') AS failed_count
      FROM cases
    `).get();
    return {
      total: Number(summary.total || 0),
      new_count: Number(summary.new_count || 0),
      running_count: Number(summary.running_count || 0),
      draft_count: Number(summary.draft_count || 0),
      replied_count: Number(summary.replied_count || 0),
      failed_count: Number(summary.failed_count || 0),
      messages: this.db.prepare("SELECT COUNT(*) AS count FROM messages").get().count,
      drafts: this.db.prepare("SELECT COUNT(*) AS count FROM drafts").get().count,
    };
  }
}

export { caseIdFor };
