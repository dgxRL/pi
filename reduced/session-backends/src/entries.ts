import type { CompactionEntry, CustomEntry, Entry, EntryScan, MessageEntry } from "./types.ts";
import { joinSqlFragments, type SqlQuery, sql } from "./sql.ts";
import type { SqliteDatabase } from "./types.ts";

export interface EntryRow {
	id: string;
	parent_id: string | null;
	seq: number;
	type: Entry["type"];
	custom_type: string | null;
	timestamp: number;
	payload: string;
}

type StoredEntryPayload<TEntry extends Entry> = Omit<
	TEntry,
	"id" | "parentId" | "seq" | "timestamp" | "type" | "customType"
>;

function entryPayload(entry: Entry): StoredEntryPayload<Entry> {
	switch (entry.type) {
		case "message": {
			const payload: StoredEntryPayload<MessageEntry> = {
				message: entry.message,
			};
			return payload;
		}
		case "compaction": {
			const payload: StoredEntryPayload<CompactionEntry> = {
				summary: entry.summary,
				retainedTail: entry.retainedTail,
				tokensBefore: entry.tokensBefore,
				fromHook: entry.fromHook,
			};
			return payload;
		}
		case "custom": {
			const payload: StoredEntryPayload<CustomEntry> = entry.data === undefined ? {} : { data: entry.data };
			return payload;
		}
	}
}

function parsePayload<TEntry extends Entry>(row: EntryRow): StoredEntryPayload<TEntry> {
	return JSON.parse(row.payload) as StoredEntryPayload<TEntry>;
}

export function insertEntryRow(db: SqliteDatabase, sessionId: string, entry: Entry): void {
	sql`INSERT INTO entries (session_id, id, parent_id, seq, type, custom_type, timestamp, payload)
		VALUES (
			${sessionId},
			${entry.id},
			${entry.parentId},
			${entry.seq},
			${entry.type},
			${entry.type === "custom" ? entry.customType : null},
			${entry.timestamp},
			${JSON.stringify(entryPayload(entry))}
		)`.run(db);
}

export function decodeEntryRow(row: EntryRow): Entry {
	const base = {
		id: row.id,
		parentId: row.parent_id,
		seq: row.seq,
		timestamp: row.timestamp,
	};
	switch (row.type) {
		case "message":
			return { ...base, type: "message", ...parsePayload<MessageEntry>(row) };
		case "compaction":
			return { ...base, type: "compaction", ...parsePayload<CompactionEntry>(row) };
		case "custom":
			if (row.custom_type === null) throw new Error(`Custom entry ${row.id} is missing custom_type`);
			return { ...base, type: "custom", customType: row.custom_type, ...parsePayload<CustomEntry>(row) };
	}
}

export function readEntryRows(db: SqliteDatabase, sessionId: string, ids: readonly string[]): EntryRow[] {
	if (ids.length === 0) return [];
	const placeholders = joinSqlFragments(
		ids.map((id) => sql`${id}`),
		", ",
	);
	return sql`SELECT id, parent_id, seq, type, custom_type, timestamp, payload
		FROM entries
		WHERE session_id = ${sessionId} AND id IN (${placeholders})`.all<EntryRow>(db);
}

export function readAllEntryRows(db: SqliteDatabase, sessionId: string): EntryRow[] {
	return sql`SELECT id, parent_id, seq, type, custom_type, timestamp, payload
		FROM entries WHERE session_id = ${sessionId} ORDER BY seq ASC`.all<EntryRow>(db);
}

export function scanEntryRows(db: SqliteDatabase, sessionId: string, query: EntryScan): EntryRow[] {
	const filters: SqlQuery[] = [sql`session_id = ${sessionId}`];
	if (query.type !== undefined) filters.push(sql`type = ${query.type}`);
	if (query.customType !== undefined) filters.push(sql`custom_type = ${query.customType}`);
	if (query.fromSeq !== undefined) filters.push(sql`seq >= ${query.fromSeq}`);
	if (query.toSeq !== undefined) filters.push(sql`seq <= ${query.toSeq}`);

	const order = query.order === "desc" ? sql`ORDER BY seq DESC` : sql`ORDER BY seq ASC`;
	const limit = query.limit === undefined ? sql`` : sql`LIMIT ${Math.max(0, query.limit)}`;
	return sql`SELECT id, parent_id, seq, type, custom_type, timestamp, payload
		FROM entries WHERE ${joinSqlFragments(filters, " AND ")} ${order} ${limit}`.all<EntryRow>(db);
}
