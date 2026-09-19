import type { DatabaseSync } from "node:sqlite";

// Latest schema only; no migrations. One database file per session, but every
// durable row is scoped by session_id. branch_* tables are maintained
// projections of the parent chain in `entries`.
//
// Dropped from the real package: usage_ledger (model-usage accounting),
// duplicate-id/parent-exists triggers (integrity armor), and storage_version.

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL,
	parent_session_id TEXT,
	metadata TEXT,
	message_count INTEGER NOT NULL,
	next_seq INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS entries (
	session_id TEXT NOT NULL,
	id TEXT NOT NULL,
	parent_id TEXT,
	seq INTEGER NOT NULL,
	type TEXT NOT NULL,
	custom_type TEXT,
	timestamp INTEGER NOT NULL,
	payload TEXT NOT NULL,
	PRIMARY KEY (session_id, id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS ix_entry_parent ON entries(session_id, parent_id);
CREATE INDEX IF NOT EXISTS ix_entry_seq ON entries(session_id, seq, type);

CREATE TABLE IF NOT EXISTS scalar_values (
	session_id TEXT NOT NULL,
	namespace TEXT NOT NULL,
	key TEXT NOT NULL,
	seq INTEGER NOT NULL,
	value TEXT NOT NULL,
	PRIMARY KEY (session_id, namespace, key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS list_values (
	session_id TEXT NOT NULL,
	namespace TEXT NOT NULL,
	key TEXT NOT NULL,
	seq INTEGER NOT NULL,
	value TEXT NOT NULL,
	PRIMARY KEY (session_id, namespace, key, seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS branch_entries (
	session_id TEXT NOT NULL,
	branch_id TEXT NOT NULL,
	entry_id TEXT NOT NULL,
	entry_seq INTEGER NOT NULL,
	entry_type TEXT NOT NULL,
	PRIMARY KEY (session_id, branch_id, entry_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS ix_be_seq ON branch_entries(session_id, branch_id, entry_seq, entry_id, entry_type);
CREATE INDEX IF NOT EXISTS ix_be_type ON branch_entries(session_id, branch_id, entry_type, entry_seq, entry_id);
CREATE INDEX IF NOT EXISTS ix_be_entry ON branch_entries(session_id, entry_id);

CREATE TABLE IF NOT EXISTS branch_meta (
	session_id TEXT NOT NULL,
	branch_id TEXT NOT NULL,
	tip_entry_id TEXT NOT NULL,
	tip_seq INTEGER NOT NULL,
	base_branch_id TEXT,
	base_seq INTEGER,
	PRIMARY KEY (session_id, branch_id)
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS ix_bm_tip ON branch_meta(session_id, tip_entry_id);
`;

export function applySchema(db: DatabaseSync): void {
	db.exec(SCHEMA_SQL);
}
