# reduced/telemetry

Standalone educational extraction of `packages/telemetry`
(`@earendil-works/pi-telemetry`): vendor-neutral telemetry contracts with an
explicit callback-based context, a no-op context, an in-memory reference
adapter, and typed schema utilities. No workspace imports, no backend.

## Run

```sh
node node_modules/vitest/dist/cli.js --run reduced/telemetry/test/telemetry.test.ts
```

4 tests. Typecheck with a throwaway tsconfig extending `tsconfig.base.json`
(`reduced/` is outside the root tsconfig and biome file list).

## Main flow

```
telemetryContext.startSpan({ name, attributes }, (span) => { ... })
  └─ span recorded; callback runs exactly once
       ├─ span.addEvent / setAttributes / setStatus   merge into the record
       └─ callback settles → span settles
            ├─ normal return        status stays ok
            └─ sync throw/rejection automatic error status (unless setStatus ran)
createTypedSpanStarter(context, [schema, ...])   compile-time span vocabulary
  └─ startSpan("name", attrs, (span, startChildSpan) => ...)   typed nesting
getSpans()   detached snapshots: id, parentId, merged attributes, ordered events, status
```

## File map (reduced -> real source, and what was trimmed)

| Reduced (lines) | Real source (lines) | Trimmed |
|---|---|---|
| `src/index.ts` (342) | `src/index.ts` (357) | `sensitive`/`cardinality` attribute metadata and `examples` fields dropped; everything else (contract + schema inference + typed starter) verbatim |
| `src/noop.ts` (22) | `src/noop.ts` (20) | verbatim |
| `src/memory.ts` (196) | `src/memory.ts` (219) | passive-recording try/catch armor, post-settlement call guards, parent-settled → noop delegation, and createSpan fallback dropped; settlement paths kept |
| `test/telemetry.test.ts` (166) | `test/telemetry.test.ts` (197) | `unreadable` proxy armor tests dropped ("does not inspect payloads", unreadable schema array); schema + noop contract tests kept |

Not ported: `src/testing/` conformance suite (315 lines + runner) — an adapter
verification harness, not part of the runtime; and `test/conformance.test.ts`.

## Simplifications

- No conformance harness; the in-memory adapter's semantics are pinned by the ported tests.
- Recording methods are plain mutations: no "ignore calls after settlement",
  no malformed/unreadable payload suppression.
- `automaticErrorStatus` inspects `error instanceof Error` directly (no defensive try/catch).
- `settleSpan` has no re-entry guard (called exactly once per span by construction).
- Attribute metadata trimmed to `description`; `values`/`elementValues` kept because
  they drive the compile-time attribute inference.

The remaining `try` blocks are load-bearing and pinned by tests:
- `noop.ts`: sync-throw → rejected promise (callback admission contract).
- `memory.ts` `startInMemorySpan`: sync-throw → settle with error status + rejection.
