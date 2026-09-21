# reduced/durable

Standalone educational extraction of `packages/durable` (`@earendil-works/
pi-durable`, 757 src lines): the durable record model (conversations, entries,
inputs, tasks) and the atomic `Storage` boundary with its detached in-memory
reference implementation. No workspace imports; `Context`/`JsonValue`/`Message`
are local stand-ins (opaque to durable).

## Run

```sh
node node_modules/vitest/dist/cli.js --run reduced/durable/test/memory-storage.test.ts reduced/durable/test/types.test.ts
```

13 tests. Typecheck with a throwaway tsconfig extending `tsconfig.base.json`
(`lib: ["ES2024"]`); `reduced/` is outside the root tsconfig and biome scope.

## Main flow

```
Session (host runtime, not in this package)
  └─ Storage.commit(writes) -> Seq        one atomic batch across four tables
       ├─ conversation { id, parent?, owner? }   fork ancestry + task ownership
       ├─ entry { kind, model?, data?, head?, edits? }   transcript events
       ├─ task { state: pending|running|terminal, checkpoint, outcome }   durable tasks
       └─ input { status: queued|placed|done|unanswered }   host input lifecycle
  └─ mintId()                             one global record ID namespace
  └─ scan* / findLatestHeadMarker         newest-first, cursor-paginated,
                                          fork-aware entry history
```

## File map (reduced -> real source, and what was trimmed)

| Reduced (lines) | Real source (lines) | Trimmed |
|---|---|---|
| `src/types.ts` (~300) | `src/types.ts` (362) | `DocumentRecord`/`DocumentCreate` dropped — a type-only future-runtime schema (no `Storage` method touches documents) with session/conversation/task scopes and history/fork policy variants; `Context`/`JsonValue`/`Message` defined locally (opaque to durable) |
| `src/memory-storage.ts` (~420) | `src/memory-storage.ts` (372) | verbatim; local imports only |
| `src/context.ts` (5) | chord `Context` | opaque marker (Storage never reads it) |
| `src/index.ts` (26) | `src/index.ts` (23) | barrel |
| `test/` (613) | same (636) | only the dropped `Document*` type assertions removed; all behavioral tests kept (they pin atomicity, detachment, fork-aware scans — the package's core concepts) |

Totals: reduced ~795 lines vs 1393 (src + test).

## Concept notes

- **Detachment**: `MemoryStorage` clones every write and every read — the
  ownership boundary serialization-backed stores get for free. The prototype-
  like-key test pins that `JSON.parse`-shaped data (`__proto__` as own key)
  round-trips without polluting prototypes.
- **Atomicity**: one `commit` applies all writes or none; immutable-ID checks
  (conversation/entry IDs are never reused; one global namespace) run before
  any mutation.
- **Fork-aware history**: entries are scanned newest-first through the
  conversation's `parent` chain, capped at each fork point (`parent.at`);
  `head` markers select the active-context start and are resolved through the
  same ancestry walk.

The remaining error paths (duplicate/immutable IDs, unknown conversations,
closed storage, exhausted ID space) are the Storage contract itself — each is
pinned by a kept test.
