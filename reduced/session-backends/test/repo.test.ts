import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../src/context.ts";
import {
	SqliteSessionRepo,
	branchTip,
	entryLabel,
	insertEntry,
	sessionName,
	setValue,
	sql,
} from "../src/index.ts";

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "pi-sqlite-session-"));
	try {
		return await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function withDb<T>(path: string, run: (db: DatabaseSync) => T): T {
	const db = new DatabaseSync(path);
	try {
		return run(db);
	} finally {
		db.close();
	}
}

/** The shared fixture tree: two entries, main-branch tip, session name, and an entry label. */
function sourceTreeWrites() {
	return [
		insertEntry({ id: "root", parentId: null, type: "custom", customType: "root" }),
		insertEntry({
			id: "child",
			parentId: "root",
			type: "message",
			message: { role: "user", content: "child", timestamp: 1 },
		}),
		setValue(branchTip("main"), "child"),
		setValue(sessionName, "before"),
		setValue(entryLabel("root"), "before-label"),
	];
}

describe("SqliteSessionRepo", () => {
	it("creates one branchless initialized session file", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				now: () => 1_700_000_000_000,
			});

			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			const metadata = session.metadata;
			expect(metadata).toMatchObject({
				id: "session",
				createdAt: 1_700_000_000_000,
			});
			expect(metadata.path).toBe(await realpath(join(directory, "session.sqlite")));

			withDb(metadata.path, (db) => {
				expect(sql`SELECT COUNT(*) AS count FROM sessions`.get<{ count: number }>(db)).toEqual({ count: 1 });
				expect(sql`SELECT message_count, next_seq FROM sessions WHERE id = ${"session"}`.get(db)).toEqual({
					message_count: 0,
					next_seq: 1,
				});
				expect(
					sql`SELECT namespace, key, seq, value FROM scalar_values WHERE session_id = ${"session"} ORDER BY seq`.all(
						db,
					),
				).toEqual([]);
				expect(sql`SELECT COUNT(*) AS count FROM list_values WHERE session_id = ${"session"}`.get(db)).toEqual({
					count: 0,
				});
			});
			await session.close(BACKGROUND_CONTEXT);
		});
	});

	it("exposes explicit branch scans through the open-session facade", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				now: () => 1_700_000_000_000,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			await session.mutate(
				(mutator) =>
					mutator.commit(
						[
							insertEntry({ id: "root", parentId: null, type: "custom", customType: "root" }),
							insertEntry({ id: "child", parentId: "root", type: "custom", customType: "child" }),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);

			expect(await session.scanBranch({ start: "child", order: "oldestFirst" }, BACKGROUND_CONTEXT)).toMatchObject([
				{ id: "root" },
				{ id: "child" },
			]);
			await session.close(BACKGROUND_CONTEXT);
			await expect(session.scanBranch({ start: "child" }, BACKGROUND_CONTEXT)).rejects.toThrow("Session is closed");
		});
	});

	it("commits an explicit mutation through the open-session facade", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				now: () => 1_700_000_000_000,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			const mutation = await session.beginMutation(BACKGROUND_CONTEXT);
			const result = await mutation.commit([setValue(sessionName, "explicit")], BACKGROUND_CONTEXT);

			expect(result.seqs).toHaveLength(1);
			expect(await mutation.getValue(sessionName, BACKGROUND_CONTEXT)).toMatchObject({
				value: "explicit",
			});
			await mutation.end(BACKGROUND_CONTEXT);
			expect(await session.getName(BACKGROUND_CONTEXT)).toBe("explicit");
			await session.close(BACKGROUND_CONTEXT);
		});
	});

	it("rejects duplicate create without deleting the existing database", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				now: () => 1,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			const { metadata } = session;

			await expect(repo.create({ id: "session" }, BACKGROUND_CONTEXT)).rejects.toThrow();
			withDb(metadata.path, (db) => {
				expect(sql`SELECT COUNT(*) AS count FROM sessions`.get<{ count: number }>(db)).toEqual({ count: 1 });
			});
			await session.close(BACKGROUND_CONTEXT);
		});
	});

	it("lists an open session", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				now: () => 1,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			const { metadata } = session;

			await expect(repo.list(undefined, BACKGROUND_CONTEXT)).resolves.toMatchObject([
				{ id: "session", path: metadata.path },
			]);
			await session.close(BACKGROUND_CONTEXT);
		});
	});

	it("rejects delete for missing files and deletes a closed session", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				now: () => 1,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			const { metadata } = session;
			await session.close(BACKGROUND_CONTEXT);

			await expect(
				repo.delete({ ...metadata, path: join(directory, "missing.sqlite") }, BACKGROUND_CONTEXT),
			).rejects.toThrow();
			await repo.delete(metadata, BACKGROUND_CONTEXT);
			await expect(access(metadata.path)).rejects.toThrow();
		});
	});

	it("closes open sessions through repo close and rejects later operations", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				now: () => 1,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);

			await repo.close(BACKGROUND_CONTEXT);

			await expect(session.getStats(BACKGROUND_CONTEXT)).rejects.toThrow("Session is closed");
			await expect(repo.list(undefined, BACKGROUND_CONTEXT)).rejects.toThrow("SqliteSessionRepo is closed");
			await expect(repo.create({ id: "other" }, BACKGROUND_CONTEXT)).rejects.toThrow("SqliteSessionRepo is closed");
			await expect(repo.close(BACKGROUND_CONTEXT)).resolves.toBeUndefined();
		});
	});

	it("opens a session and round-trips metadata", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				now: () => 1,
			});
			const created = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			const { metadata } = created;
			await created.close(BACKGROUND_CONTEXT);

			const opened = await repo.open(metadata, BACKGROUND_CONTEXT);
			expect(opened.metadata).toMatchObject({ id: "session", path: metadata.path });
			await opened.close(BACKGROUND_CONTEXT);
		});
	});

	it("removes WAL and SHM sidecars on delete", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				now: () => 1,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			await session.close(BACKGROUND_CONTEXT);
			await writeFile(`${session.metadata.path}-wal`, "");
			await writeFile(`${session.metadata.path}-shm`, "");

			await repo.delete(session.metadata, BACKGROUND_CONTEXT);

			await expect(access(session.metadata.path)).rejects.toThrow();
			await expect(access(`${session.metadata.path}-wal`)).rejects.toThrow();
			await expect(access(`${session.metadata.path}-shm`)).rejects.toThrow();
		});
	});

	it("forks a branch scope by default tip", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				now: () => 1_700_000_000_000,
			});
			const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
			await source.mutate((mutator) => mutator.commit(sourceTreeWrites(), BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
			await source.close(BACKGROUND_CONTEXT);

			const fork = await repo.fork(
				source.metadata,
				{ id: "fork", scope: "branch", branch: "main" },
				BACKGROUND_CONTEXT,
			);

			expect((await fork.findEntries({ order: "asc" }, BACKGROUND_CONTEXT)).map(({ id }) => id)).toEqual([
				"root",
				"child",
			]);
			expect(await fork.getName(BACKGROUND_CONTEXT)).toBe("before");
			expect(await fork.getLabel("root", BACKGROUND_CONTEXT)).toBe("before-label");
			await expect((await fork.branch("main", BACKGROUND_CONTEXT))?.getTipId(BACKGROUND_CONTEXT)).resolves.toBe(
				"child",
			);
			expect((await fork.getStats(BACKGROUND_CONTEXT)).messageCount).toBe(1);

			await fork.close(BACKGROUND_CONTEXT);
		});
	});

	it("forks a branch scope at an earlier entry", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				now: () => 1_700_000_000_000,
			});
			const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
			await source.mutate((mutator) => mutator.commit(sourceTreeWrites(), BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
			await source.close(BACKGROUND_CONTEXT);

			const fork = await repo.fork(
				source.metadata,
				{ id: "fork-at-root", scope: "branch", branch: "main", entryId: "root" },
				BACKGROUND_CONTEXT,
			);

			expect((await fork.findEntries({ order: "asc" }, BACKGROUND_CONTEXT)).map(({ id }) => id)).toEqual(["root"]);
			await expect((await fork.branch("main", BACKGROUND_CONTEXT))?.getTipId(BACKGROUND_CONTEXT)).resolves.toBe(
				"root",
			);
			expect((await fork.getStats(BACKGROUND_CONTEXT)).messageCount).toBe(0);

			await fork.close(BACKGROUND_CONTEXT);
		});
	});

	it("forks tree scope copying the whole tree", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				now: () => 1_700_000_000_000,
			});
			const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
			await source.mutate((mutator) => mutator.commit(sourceTreeWrites(), BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
			await source.close(BACKGROUND_CONTEXT);

			const fork = await repo.fork(source.metadata, { id: "fork-tree", scope: "tree" }, BACKGROUND_CONTEXT);

			expect((await fork.findEntries({ order: "asc" }, BACKGROUND_CONTEXT)).map(({ id }) => id)).toEqual([
				"root",
				"child",
			]);
			expect(await fork.getName(BACKGROUND_CONTEXT)).toBe("before");

			await fork.close(BACKGROUND_CONTEXT);
		});
	});
});
