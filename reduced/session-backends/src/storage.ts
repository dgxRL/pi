import type { Context } from "./context.ts";
import { prepareStorageCommit } from "./commit.ts";
import type {
	CommitResult,
	Entry,
	EntryScan,
	SessionStats,
	Storage,
	StorageBranchScan,
	Write,
} from "./types.ts";
import { inTransaction } from "./sql.ts";
import type { ListElement, ListReadOptions, StoredValue, Value, ValueList } from "./values.ts";
import { appendEntryToBranchIndex, scanBranchEntries } from "./branch-entries.ts";
import { decodeEntryRow, insertEntryRow, readEntryRows, scanEntryRows } from "./entries.ts";
import {
	advanceNextSeq,
	incrementMessageCount,
	readNextSeq,
	readSessionStats,
} from "./session-row.ts";
import {
	appendListValueRow,
	deleteListValueRows,
	deleteScalarValueRow,
	readListValueRows,
	readScalarValueRow,
	scanScalarValueRows,
	setScalarValueRow,
} from "./value-rows.ts";
import type { SqliteDatabase } from "./types.ts";

export interface SqliteStorageOptions {
	sessionId: string;
	now?: () => number;
}

export class SqliteStorage implements Storage {
	private readonly db: SqliteDatabase;
	private readonly sessionId: string;
	private readonly now: () => number;

	constructor(db: SqliteDatabase, options: SqliteStorageOptions) {
		this.db = db;
		this.sessionId = options.sessionId;
		this.now = options.now ?? Date.now;
	}

	async commit(writes: Write[], _context: Context): Promise<CommitResult> {
		return this.applyCommit(writes);
	}

	getEntries(ids: string[], _context: Context): Promise<Map<string, Entry>> {
		const rowsById = new Map(readEntryRows(this.db, this.sessionId, ids).map((row) => [row.id, row]));
		const entries = new Map<string, Entry>();
		for (const id of ids) {
			const row = rowsById.get(id);
			if (row !== undefined) entries.set(id, decodeEntryRow(row));
		}
		return Promise.resolve(entries);
	}

	getValue<T>(address: Value<T>, _context: Context): Promise<StoredValue<T> | undefined> {
		return Promise.resolve(readScalarValueRow(this.db, this.sessionId, address));
	}

	scanValues<T>(prefix: Value<T>, _context: Context): Promise<StoredValue<T>[]> {
		return Promise.resolve(scanScalarValueRows(this.db, this.sessionId, prefix));
	}

	async readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		_context: Context,
	): Promise<ListElement<T>[]> {
		return readListValueRows(this.db, this.sessionId, address, options);
	}

	scanBranch(query: StorageBranchScan, _context: Context): Promise<Entry[]> {
		return Promise.resolve().then(() => scanBranchEntries(this.db, this.sessionId, query));
	}

	scanEntries(query: EntryScan, _context: Context): Promise<Entry[]> {
		return Promise.resolve(scanEntryRows(this.db, this.sessionId, query).map(decodeEntryRow));
	}

	getStats(_context: Context): Promise<SessionStats> {
		return Promise.resolve(readSessionStats(this.db, this.sessionId));
	}

	close(_context: Context): Promise<void> {
		return Promise.resolve();
	}

	private applyCommit(writes: Write[]): CommitResult {
		return inTransaction(this.db, () => {
			const firstSeq = readNextSeq(this.db, this.sessionId);
			const prepared = prepareStorageCommit(writes, firstSeq, this.now());
			for (const write of prepared.writes) {
				switch (write.kind) {
					case "entry": {
						const { kind: _kind, ...entry } = write;
						insertEntryRow(this.db, this.sessionId, entry);
						appendEntryToBranchIndex(this.db, this.sessionId, entry);
						if (entry.type === "message") incrementMessageCount(this.db, this.sessionId);
						break;
					}
					case "value":
						if (write.op === "delete") {
							deleteScalarValueRow(this.db, this.sessionId, write.namespace, write.key);
						} else {
							setScalarValueRow(this.db, this.sessionId, write.namespace, write.key, write.seq, write.value);
						}
						break;
					case "list":
						if (write.op === "delete") {
							deleteListValueRows(this.db, this.sessionId, write.namespace, write.key);
						} else {
							appendListValueRow(this.db, this.sessionId, write.namespace, write.key, write.seq, write.value);
						}
						break;
				}
			}
			advanceNextSeq(this.db, this.sessionId, firstSeq + prepared.writes.length);
			return { ...prepared.result, stats: readSessionStats(this.db, this.sessionId) };
		});
	}
}
