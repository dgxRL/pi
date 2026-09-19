import type { DatabaseSync } from "node:sqlite";
import type { SqlRunResult } from "./types.ts";

type SqlTemplateValue = unknown | SqlQuery;

/** Mirrors the unexported node:sqlite SQLInputValue. */
type SqlParam = null | number | bigint | string | NodeJS.ArrayBufferView;

/** A parameterized SQLite query produced by the `sql` template tag. */
export class SqlQuery {
	readonly queryText: string;
	readonly params: readonly unknown[];

	constructor(queryText: string, params: readonly unknown[] = []) {
		this.queryText = queryText;
		this.params = params;
	}

	run(db: DatabaseSync): SqlRunResult {
		return db.prepare(this.queryText).run(...(this.params as SqlParam[]));
	}

	get<TRow extends object>(db: DatabaseSync): TRow | undefined {
		return db.prepare(this.queryText).get(...(this.params as SqlParam[])) as TRow | undefined;
	}

	all<TRow extends object>(db: DatabaseSync): TRow[] {
		return db.prepare(this.queryText).all(...(this.params as SqlParam[])) as TRow[];
	}
}

/** Builds a parameterized query. Nested queries are inlined; other interpolations become `?` parameters. */
export function sql(strings: TemplateStringsArray, ...values: SqlTemplateValue[]): SqlQuery {
	let queryText = strings[0] ?? "";
	const params: unknown[] = [];
	for (let index = 0; index < values.length; index++) {
		const value = values[index];
		if (value instanceof SqlQuery) {
			queryText += value.queryText;
			params.push(...value.params);
		} else {
			queryText += "?";
			params.push(value);
		}
		queryText += strings[index + 1] ?? "";
	}
	return new SqlQuery(queryText, params);
}

/** Joins trusted query fragments while preserving their parameter order. */
export function joinSqlFragments(fragments: readonly SqlQuery[], separator: string): SqlQuery {
	let queryText = "";
	const params: unknown[] = [];
	for (let index = 0; index < fragments.length; index++) {
		if (index > 0) queryText += separator;
		const fragment = fragments[index]!;
		queryText += fragment.queryText;
		params.push(...fragment.params);
	}
	return new SqlQuery(queryText, params);
}

/** Runs a synchronous write transaction. Rollback-and-rethrow keeps partial writes out. */
export function inTransaction<T>(db: DatabaseSync, callback: () => T): T {
	db.exec("BEGIN");
	try {
		const result = callback();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}
