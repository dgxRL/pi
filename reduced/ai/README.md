# reduced/ai

Standalone educational extraction of `packages/ai` (`@earendil-works/pi-ai`,
~25k src lines): the LLM streaming contract, the event spine, a minimal model
registry, and the faux provider — the single in-process provider
implementation. No wire protocol, no HTTP, no provider-specific code. Deps are
`typebox` and `partial-json` (real boundaries).

## Run

```sh
node node_modules/vitest/dist/cli.js --run reduced/ai/test/event-stream.test.ts reduced/ai/test/faux.test.ts
```

19 tests. Typecheck with a throwaway tsconfig extending `tsconfig.base.json`
(`lib: ["ES2024"]` for `Promise.withResolvers`); `reduced/` is outside the root
tsconfig and biome file list.

## Main flow

```
registerFauxProvider({ models, tokensPerSecond?, tokenSize? })   scripted provider
  └─ setResponses([AssistantMessage | factory, ...])             response queue
stream(model, context, options)            registry dispatch by model.provider
  └─ AssistantMessageEventStream           async-iterable event spine + .result()
       ├─ start                            live `partial` accumulator begins
       ├─ text_start / delta / end         per content block, stable contentIndex
       ├─ thinking_start / delta / end
       ├─ toolcall_start / delta / end     args arrive as partial-JSON deltas
       └─ done(reason) | error(reason)     result() resolves final AssistantMessage
complete(model, context, options)          stream(...).result()

agentic loop: toolcall_end -> push AssistantMessage + ToolResultMessage -> stream again
```

## File map (reduced -> real source, and what was trimmed)

| Reduced (lines) | Real source (lines) | Trimmed |
|---|---|---|
| `src/types.ts` (141) | `src/types.ts` (990) | one Api literal (`"faux"`), no images/deferred/constrained-sampling/compat maps, `IsJsonCompatible` type machinery -> plain `JsonValue` details, no `cacheWrite1h`/`reasoning` usage split, SystemMessage without sections/tool deltas, no HTTP transport options |
| `src/event-stream.ts` (115) | `src/utils/event-stream.ts` (110) | verbatim (`Promise.withResolvers` per repo rule) |
| `src/json-parse.ts` (124) | `src/utils/json-parse.ts` (124) | verbatim |
| `src/registry.ts` (54) | `src/models.ts` (966) | no Provider/Models factories, no auth/refresh/catalog persistence: one map provider -> {models, stream} |
| `src/faux.ts` (491) | `src/providers/faux.ts` (708) | no deferred machinery; streaming/pacing/usage-estimation/session-caching verbatim |
| `src/index.ts` (8) | `src/index.ts` (49) | barrel; no side-effect registrations |
| `test/event-stream.test.ts` (94) | same | verbatim |
| `test/faux.test.ts` (406) | `test/faux-provider.test.ts` (616) | 14 of 19 tests: dropped deferred/replace-responses/cacheRetention-none/partial-abort variants |

Totals: reduced src ~933 lines vs 24.8k; tests 500 vs 37.6k.

## Removed as provider-specific

- **All wire protocols**, including the previously ported anthropic-messages
  adapter (SSE decoder, 6-event wire mapping, `cost.ts` calculator, generated
  model catalog, and its fake-fetch wire tests). Every real provider in
  `packages/ai` (`src/api/*`, `src/auth/*`, `src/models.generated.ts`) is
  out of scope: the reduced copy has no HTTP transport at all.
- `StreamOptions` reduced to what in-process providers consume: `signal`,
  `sessionId`, `cacheRetention`. `apiKey`/`fetch`/`temperature`/`maxTokens`
  and `Model.baseUrl` existed only for HTTP providers.
- `calculateCost` — its only caller was the wire adapter; `Usage.cost` stays
  in the contract, faux fills zeros.

## Simplifications

- Registry is a Map, not a provider class hierarchy.
- Faux is the reference implementation of `StreamFunction`: it demonstrates the
  full event choreography (start -> per-block start/delta(s)/end -> done/error)
  without any network.
- `parseStreamingJson` (verbatim) stays: the contract says tool-call arguments
  arrive as partial-JSON deltas, and faux exercises that shape.

Remaining `try` blocks are load-bearing and pinned by tests:
- `faux.ts`: callback settlement -> automatic error status, abort -> aborted.
- `json-parse.ts`: partial-JSON fallback chain (parseStreamingJson never throws).
