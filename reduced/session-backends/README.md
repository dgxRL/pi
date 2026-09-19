# reduced/session-backends

Standalone educational extraction of
`packages/session-backends/sqlite-node` (`@earendil-works/pi-session-backend-sqlite-node`):
a durable session store on `node:sqlite` with an entry tree, materialized branch
segments, and typed scalar/list values. No imports from workspace packages; the
`pi-agent-core` contract layer is ported into `src/types.ts`, `src/values.ts`,
`src/commit.ts`, `src/context.ts`, and `src/mutation-line.ts`.

## Run

```sh
node node_modules/vitest/dist/cli.js --run reduced/session-backends/test/storage.test.ts reduced/session-backends/test/repo.test.ts
```

25 tests. Typecheck with a throwaway tsconfig extending `tsconfig.base.json`
(`reduced/` is outside the root tsconfig and biome file list).

## Main flow

```
repo.create({ id })            one `<id>.sqlite` file, WAL, latest schema
  └─ StorageBackedSession      metadata + SqliteStorage over one DatabaseSync
       ├─ mutate / beginMutation   MutationLine serializes read-modify-write jobs
       ├─ createBranch / branch    branch tip stored as a scalar value (pi.branch.tip)
       ├─ appendMessage            entry row + branch index update + tip update, one tx
       └─ scanBranch               walks materialized branch segments incl. compaction bases
repo.open / list / delete / fork / close
```

## File map (reduced -> real source, and what was trimmed)

| Reduced (lines) | Real source (lines) | Trimmed |
|---|---|---|
| `types.ts` (219) | `agent/src/harness/session/types.ts` (602) | no `branch_summary` entry, no usage/lanes/operation state, `AgentMessage` reduced to `{role, content, timestamp}`, no storageVersion, no driver abstraction (`SqliteDatabase = DatabaseSync`) |
| `values.ts` (112) | `agent/src/harness/session/values.ts` (195) | address validation, lane/op/pending addresses, freeze |
| `commit.ts` (73) | `agent/src/harness/session/commit.ts` (116) | no usage write kind, no commit validation |
| `sql.ts` (74) | `sqlite-node/src/sqlite/sql.ts` (66) + node adapter | no `iterate`/`exec`, no Database wrapper; `inTransaction` helper instead of driver method |
| `schema.ts` (81) | `sqlite-node/src/sqlite/migrations.ts` + `migrations/001_initial.sql` | latest DDL only: no migration loader, no `storage_version`, no `usage_ledger`, no triggers |
| `session-row.ts` (86) | `sqlite-node/src/sqlite/session/session-row.ts` (102) + `session-stats.ts` (45) + `session-sequences.ts` (14) | no usage stats, no version gate |
| `entries.ts` (107) | `sqlite-node/src/sqlite/session/entries.ts` (161) | no `branch_summary` payload, no structure rows, `EntryRowWriter` class -> one function |
| `value-rows.ts` (146) | `sqlite-node/src/sqlite/session/values.ts` (146) | verbatim (core prefix-scan algorithm kept) |
| `branch-entries.ts` (277) | `sqlite-node/src/sqlite/session/branch-entries.ts` (324) | structure scans dropped |
| `storage.ts` (128) | `sqlite-node/src/sqlite/storage.ts` (211) | no commit queue, no closed-state guards, no snapshot/usage/structure scans |
| `fork.ts` (113) | `agent/src/harness/session/fork.ts` (94) + `fork-policy.ts` (67) | no lane reset/validation, no `position`, branch walk simplified |
| `session.ts` (386) | `agent/src/harness/session/session.ts` (475) | error classes -> plain Error, no branch-name validation, no pending-assistant check, no cursor short-circuits |
| `repo.ts` (216) | `sqlite-node/src/sqlite/repo.ts` (453) | no databaseFactory/shared container, no id encoding (ASCII ids only), no ownership guard, no metadata-path realpath check, no best-effort list, no fork snapshot queue (fork always reads the source file read-only) |
| `mutation-line.ts` (23) | `agent/src/harness/session/mutation-line.ts` (23) | verbatim |
| `context.ts` (5) | `agent/src/harness/context.ts` (37) + chord | opaque marker; the real Context carries abort signal + keyed values |

Totals: reduced src 1914 lines vs real ~2700+ (plus the deleted adapter/index
wrapper); tests 770 vs 1830.

## Simplifications

- No usage/token accounting anywhere (no `usage_ledger` table, `SessionStats` is `{ messageCount }`).
- No migrations or storage-version gate: `applySchema` creates the latest DDL directly.
- `node:sqlite` used directly (`DatabaseSync`); the driver factory, read-only/no-create
  open distinctions, and shared-container `databasePath` mode are gone.
- One `<id>.sqlite` file per session, ASCII ids only (no base64url id encoding).
- No ownership/overlap guard (`pendingIds`), no metadata-path validation, no
  corrupt-file skip in `list` — errors fail fast.
- Fork always snapshots the source database read-only from disk; the commit-queue
  snapshot path for live sources is gone (commits are synchronous, so the file is current).
- Entry kinds: `message` | `compaction` | `custom` (no `branch_summary`).
- Ids from `crypto.randomUUID()` (was timestamp-ordered `uuidv7`).

Dropped `try/catch` armor per the edge-case-strip pass; the only remaining
`try` is `inTransaction`'s rollback-and-rethrow.
