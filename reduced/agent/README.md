# reduced/agent

Standalone educational extraction of `packages/agent` (`@earendil-works/
pi-agent-core`, 33.3k src lines): the root **Agent + agent-loop** production
path — stream an assistant response, execute tool calls, feed results back,
repeat until done, with a lifecycle event stream and queue-based steering. No
workspace imports; deps are `typebox` + `partial-json` + vitest (tests).

## Run

```sh
node node_modules/vitest/dist/cli.js --run reduced/agent/test/agent-loop.test.ts reduced/agent/test/agent.test.ts reduced/agent/test/e2e.test.ts
```

29 tests. Typecheck with a throwaway tsconfig extending `tsconfig.base.json`
(`lib: ["ES2024"]`); `reduced/` is outside the root tsconfig and biome scope.

## Main flow

```
new Agent({ streamFn, initialState })           owns transcript + tools + queues
  └─ prompt("...")                              user message -> lifecycle run
       └─ runAgentLoop(prompts, context, config, emit, signal, streamFn)
            └─ runLoop:  for (;;) {
                 steer?      -> inject queued messages
                 stream      -> convertToLlm -> streamFn -> pump assistant events
                 toolCalls?  -> prepare (validate + beforeToolCall)
                             -> execute (sequential | parallel) + afterToolCall
                             -> append ToolResultMessage(s)
                 done?       -> follow-ups? else agent_end
               }
events: agent_start / turn_start / message_start / message_update / message_end
        / tool_execution_start|update|end / turn_end / agent_end
```

## File map (reduced -> real source, and what was trimmed)

| Reduced (lines) | Real source (lines) | Trimmed |
|---|---|---|
| `src/types.ts` (291) | `src/types.ts` (463) | minimal LLM shapes defined locally (no images/thinking/deferred), no tool-loadout announcement types, `any` -> `unknown`, no pi-ai re-imports |
| `src/agent-loop.ts` (759) | `src/agent-loop.ts` (857) | tool-loadout announcements (`declareToolChanges`), truncated-message tool failing, `normalizeContext` branding, onPayload/onResponse/thinking-budget plumbing dropped; turn loop, steering/follow-up/prepareNextTurn, sequential+parallel tool execution, before/after hooks verbatim |
| `src/agent.ts` (576) | `src/agent.ts` (607) | option plumbing (transport/budgets/retry caps/sessionId forwarding) and prompt-with-images overload dropped; state machine, queues, abort, reset verbatim |
| `src/llm-boundary.ts` (165) | pi-ai `utils/transcript.ts` + validation helpers | the four transcript-replay helpers, `toToolDeclaration`, `validateToolArguments` extracted so the loop's LLM boundary is visible in one file |
| `src/event-stream.ts` (115) | pi-ai `utils/event-stream.ts` (110) | verbatim (same port as reduced/ai) |
| `src/stream-fn.ts` (19) | `src/stream-fn.ts` (21) | verbatim |
| `test/` (1589) | `test/{agent-loop,agent,e2e}.test.ts` (3038) | pruned to main flows; `MockAssistantStream` helper ported; e2e re-scripted over the mock (faux provider lives in reduced/ai, out of reach) |

Totals: reduced src ~1932 lines vs 33.3k.

## Intentionally dropped (with rationale)

- **`harness/` runtime** (lane/drive state machine ~5k, restore/recovery/deferred/
  reconcile ~2.4k, pico3 experimental ~8k, jsonl persistence ~1.9k, conformance
  scaffolding ~2.7k): a durable worker architecture consumed only by
  coding-agent/experimental. The production hot path is the root Agent —
  confirmed by import trace. Crash-restore/replay is edge machinery by the
  strip-pass standard.
- **compaction** (~1.2k): driven by the harness checkpoint path, unreachable
  from the reduced loop.
- **telemetry, skills, prompt-templates, tools/ library, env/nodejs, proxy,
  search**: platform/feature machinery; the runtime never imports the tools
  library (coding-agent ships its own).
- **session/** (`StorageBackedSession`, memory backend): the durable entry/value
  model is already taught by `reduced/session-backends` (Storage contract +
  sqlite backend); the reduced loop keeps context in memory.

The StreamFn contract is unchanged from production: failures arrive as normal
assistant messages with stopReason "error"/"aborted" through the stream, never
as exceptions.
