import Database from "better-sqlite3";
import path from "path";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = path.join(process.cwd(), "oneagent.db");
  db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Chat',
      provider TEXT NOT NULL DEFAULT 'anthropic',
      model TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      tool_name TEXT,
      tool_call_id TEXT,
      is_error INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
  `);

  return db;
}

// --- Conversation queries ---

export interface Conversation {
  id: string;
  title: string;
  provider: string;
  model: string | null;
  created_at: string;
  updated_at: string;
}

export function listConversations(): Conversation[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM conversations ORDER BY updated_at DESC")
    .all() as Conversation[];
}

export function getConversation(id: string): Conversation | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM conversations WHERE id = ?")
    .get(id) as Conversation | undefined;
}

export function createConversation(
  id: string,
  title: string = "New Chat",
  provider: string = "anthropic",
  model?: string
): Conversation {
  const db = getDb();
  db.prepare(
    "INSERT INTO conversations (id, title, provider, model) VALUES (?, ?, ?, ?)"
  ).run(id, title, provider, model ?? null);
  return getConversation(id)!;
}

export function updateConversationTitle(id: string, title: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(title, id);
}

export function updateConversationTimestamp(id: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?"
  ).run(id);
}

export function deleteConversation(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
}

// --- Message queries ---

export interface DbMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_name: string | null;
  tool_call_id: string | null;
  is_error: number;
  created_at: string;
}

export function getMessages(conversationId: string): DbMessage[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC"
    )
    .all(conversationId) as DbMessage[];
}

export function addMessage(
  id: string,
  conversationId: string,
  role: string,
  content: string,
  toolName?: string,
  toolCallId?: string,
  isError: boolean = false
): DbMessage {
  const db = getDb();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, tool_name, tool_call_id, is_error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, conversationId, role, content, toolName ?? null, toolCallId ?? null, isError ? 1 : 0);
  return db
    .prepare("SELECT * FROM messages WHERE id = ?")
    .get(id) as DbMessage;
}

export function deleteMessages(conversationId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(
    conversationId
  );
}

// --- Settings queries ---

export function getSetting(key: string): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
  ).run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM settings").all() as {
    key: string;
    value: string;
  }[];
  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}
