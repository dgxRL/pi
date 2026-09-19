import { sql } from "./sql.ts";
import type { SessionMetadata, SessionStats, SqliteDatabase } from "./types.ts";

export interface SessionRow {
	id: string;
	created_at: number;
	parent_session_id: string | null;
	metadata: string | null;
	message_count: number;
	next_seq: number;
}

export interface SqliteSessionMetadata extends SessionMetadata {
	/** SQLite container/shard path containing this session. */
	path: string;
}

export function readSessionRow(db: SqliteDatabase, sessionId: string): SessionRow {
	const row = sql`SELECT id, created_at, parent_session_id, metadata, message_count, next_seq
		FROM sessions
		WHERE id = ${sessionId}`.get<SessionRow>(db);
	if (row === undefined) throw new Error(`Unknown SQLite session: ${sessionId}`);
	return row;
}

export function readAllSessionRows(db: SqliteDatabase): SessionRow[] {
	return sql`SELECT id, created_at, parent_session_id, metadata, message_count, next_seq
		FROM sessions`.all<SessionRow>(db);
}

export function hasSessionRow(db: SqliteDatabase, sessionId: string): boolean {
	return sql`SELECT id FROM sessions WHERE id = ${sessionId}`.get<{ id: string }>(db) !== undefined;
}

export function metadataFromSessionRow(path: string, row: SessionRow): SqliteSessionMetadata {
	return {
		id: row.id,
		createdAt: row.created_at,
		...(row.parent_session_id === null ? {} : { parentSessionId: row.parent_session_id }),
		path,
	};
}

export function insertSessionRow(db: SqliteDatabase, metadata: SqliteSessionMetadata, nextSeq: number): void {
	sql`INSERT INTO sessions
			(id, created_at, parent_session_id, metadata, message_count, next_seq)
		VALUES (
			${metadata.id},
			${metadata.createdAt},
			${metadata.parentSessionId ?? null},
			${null},
			${0},
			${nextSeq}
		)`.run(db);
}

export function deleteSessionRows(db: SqliteDatabase, sessionId: string): void {
	sql`DELETE FROM entries WHERE session_id = ${sessionId}`.run(db);
	sql`DELETE FROM scalar_values WHERE session_id = ${sessionId}`.run(db);
	sql`DELETE FROM list_values WHERE session_id = ${sessionId}`.run(db);
	sql`DELETE FROM branch_entries WHERE session_id = ${sessionId}`.run(db);
	sql`DELETE FROM branch_meta WHERE session_id = ${sessionId}`.run(db);
	const result = sql`DELETE FROM sessions WHERE id = ${sessionId}`.run(db);
	if (result.changes !== 1)
		throw new Error(`Expected to delete one SQLite session ${sessionId}, deleted ${result.changes}`);
}

export function readSessionStats(db: SqliteDatabase, sessionId: string): SessionStats {
	return { messageCount: readSessionRow(db, sessionId).message_count };
}

export function incrementMessageCount(db: SqliteDatabase, sessionId: string): void {
	sql`UPDATE sessions SET message_count = message_count + 1 WHERE id = ${sessionId}`.run(db);
}

export function readNextSeq(db: SqliteDatabase, sessionId: string): number {
	const row = sql`SELECT next_seq FROM sessions WHERE id = ${sessionId}`.get<{ next_seq: number }>(db);
	if (row === undefined) throw new Error(`Unknown SQLite session: ${sessionId}`);
	return row.next_seq;
}

export function advanceNextSeq(db: SqliteDatabase, sessionId: string, nextSeq: number): void {
	const result = sql`UPDATE sessions SET next_seq = ${nextSeq} WHERE id = ${sessionId}`.run(db);
	if (result.changes !== 1)
		throw new Error(`Expected to update one SQLite session ${sessionId}, updated ${result.changes}`);
}
