// Reduced from packages/session-backends/sqlite-node/src/sqlite/repo.ts.
// One `${id}.sqlite` file per session under a directory; no shared container, no id encoding.

import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { appendEntryToBranchIndex } from "./branch-entries.ts";
import { createForkSnapshot } from "./fork.ts";
import { decodeEntryRow, insertEntryRow, readAllEntryRows } from "./entries.ts";
import { applySchema } from "./schema.ts";
import {
	hasSessionRow,
	insertSessionRow,
	metadataFromSessionRow,
	readAllSessionRows,
	readSessionRow,
	type SqliteSessionMetadata,
} from "./session-row.ts";
import { StorageBackedSession } from "./session.ts";
import { inTransaction, sql } from "./sql.ts";
import type { Context } from "./context.ts";
import type { Entry, ForkOptions, SessionCreateOptions, SqliteDatabase } from "./types.ts";
import type { StoredValue } from "./values.ts";
import { readAllScalarValueRows, setScalarValueRow } from "./value-rows.ts";
import { SqliteStorage } from "./storage.ts";

export interface SqliteSessionRepoOptions {
	directory: string;
	now?: () => number;
}

const FIRST_AVAILABLE_COMMIT_SEQ = 1;
const SQLITE_SESSION_EXTENSION = ".sqlite";

export class SqliteSessionRepo {
	private readonly directory: string;
	private readonly now: () => number;
	private readonly openSessions = new Set<StorageBackedSession<SqliteSessionMetadata>>();
	private closed = false;
	private closePromise: Promise<void> | undefined;

	constructor(options: SqliteSessionRepoOptions) {
		this.directory = options.directory;
		this.now = options.now ?? Date.now;
	}

	async create(
		options: SessionCreateOptions | undefined,
		_context: Context,
	): Promise<StorageBackedSession<SqliteSessionMetadata>> {
		this.assertOpen();
		options ??= {};
		const id = options.id ?? randomUUID();
		const createdAt = this.now();
		const path = join(this.directory, `${id}.sqlite`);
		let db: SqliteDatabase | undefined;
		let session: StorageBackedSession<SqliteSessionMetadata> | undefined;
		try {
			await mkdir(dirname(path), { recursive: true });
			const activeDb = new DatabaseSync(path);
			db = activeDb;
			activeDb.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
			applySchema(activeDb);
			const metadata: SqliteSessionMetadata = {
				id,
				createdAt,
				...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
				path: await realpath(path),
			};
			inTransaction(activeDb, () => {
				if (hasSessionRow(activeDb, id)) throw new Error(`SQLite session already exists: ${id}`);
				insertSessionRow(activeDb, metadata, FIRST_AVAILABLE_COMMIT_SEQ);
			});
			session = this.openStorageBackedSession(metadata, activeDb);
			return session;
		} catch (error) {
			if (session === undefined) db?.close();
			throw error;
		}
	}

	async open(metadata: SqliteSessionMetadata, _context: Context): Promise<StorageBackedSession<SqliteSessionMetadata>> {
		this.assertOpen();
		let db: SqliteDatabase | undefined;
		let session: StorageBackedSession<SqliteSessionMetadata> | undefined;
		try {
			const activeDb = new DatabaseSync(metadata.path);
			db = activeDb;
			activeDb.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
			const stored = metadataFromSessionRow(await realpath(metadata.path), readSessionRow(activeDb, metadata.id));
			session = this.openStorageBackedSession(stored, activeDb);
			return session;
		} catch (error) {
			if (session === undefined) db?.close();
			throw error;
		}
	}

	async list(_options: undefined, _context: Context): Promise<SqliteSessionMetadata[]> {
		this.assertOpen();
		const names = await readdir(this.directory);
		const sessions: SqliteSessionMetadata[] = [];
		for (const name of names) {
			if (!name.endsWith(SQLITE_SESSION_EXTENSION)) continue;
			const path = join(this.directory, name);
			const db = new DatabaseSync(path, { readOnly: true });
			try {
				const canonicalPath = await realpath(path);
				for (const row of readAllSessionRows(db)) {
					sessions.push(metadataFromSessionRow(canonicalPath, row));
				}
			} finally {
				db.close();
			}
		}
		return sessions.sort((left, right) => right.createdAt - left.createdAt);
	}

	async delete(metadata: SqliteSessionMetadata, _context: Context): Promise<void> {
		this.assertOpen();
		const db = new DatabaseSync(metadata.path);
		try {
			readSessionRow(db, metadata.id);
		} finally {
			db.close();
		}
		await rm(metadata.path, { force: true });
		await rm(`${metadata.path}-wal`, { force: true });
		await rm(`${metadata.path}-shm`, { force: true });
	}

	async fork(
		source: SqliteSessionMetadata,
		options: ForkOptions,
		_context: Context,
	): Promise<StorageBackedSession<SqliteSessionMetadata>> {
		this.assertOpen();
		const id = options.id ?? randomUUID();
		const createdAt = this.now();
		const path = join(this.directory, `${id}.sqlite`);

		const sourceDb = new DatabaseSync(source.path, { readOnly: true });
		let sourceEntries: Entry[];
		let sourceValues: StoredValue<unknown>[];
		try {
			sourceEntries = readAllEntryRows(sourceDb, source.id).map(decodeEntryRow);
			sourceValues = readAllScalarValueRows(sourceDb, source.id);
		} finally {
			sourceDb.close();
		}
		const snapshot = createForkSnapshot({ entries: sourceEntries, scalarValues: sourceValues }, options);

		let db: SqliteDatabase | undefined;
		let session: StorageBackedSession<SqliteSessionMetadata> | undefined;
		try {
			await mkdir(dirname(path), { recursive: true });
			const activeDb = new DatabaseSync(path);
			db = activeDb;
			activeDb.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
			applySchema(activeDb);
			const metadata: SqliteSessionMetadata = {
				id,
				createdAt,
				parentSessionId: source.id,
				path: await realpath(path),
			};
			inTransaction(activeDb, () => {
				if (hasSessionRow(activeDb, id)) throw new Error(`SQLite session already exists: ${id}`);
				insertSessionRow(activeDb, metadata, snapshot.nextSeq);
				for (const entry of snapshot.entries) {
					insertEntryRow(activeDb, id, entry);
					appendEntryToBranchIndex(activeDb, id, entry);
				}
				const messageCount = snapshot.entries.filter((entry) => entry.type === "message").length;
				sql`UPDATE sessions SET message_count = ${messageCount} WHERE id = ${id}`.run(activeDb);
				for (const stored of snapshot.scalarValues) {
					setScalarValueRow(activeDb, id, stored.address.namespace, stored.address.key, stored.seq, stored.value);
				}
			});
			session = this.openStorageBackedSession(metadata, activeDb);
			return session;
		} catch (error) {
			if (session === undefined) db?.close();
			throw error;
		}
	}

	async close(context: Context): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.closed = true;
		this.closePromise = Promise.all([...this.openSessions].map((session) => session.close(context))).then(
			() => undefined,
		);
		return this.closePromise;
	}

	private openStorageBackedSession(
		metadata: SqliteSessionMetadata,
		db: SqliteDatabase,
	): StorageBackedSession<SqliteSessionMetadata> {
		const storage = new SqliteStorage(db, { sessionId: metadata.id, now: this.now });
		const session = new StorageBackedSession<SqliteSessionMetadata>(metadata, storage, {
			onClose: () => {
				db.close();
				this.openSessions.delete(session);
			},
		});
		this.openSessions.add(session);
		return session;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("SqliteSessionRepo is closed");
	}
}
