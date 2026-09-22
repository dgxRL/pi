# reduced/coding-agent

Standalone educational extraction of `packages/coding-agent` (`@earendil-works/
pi-coding-agent`, 71.9k src lines): the coding-agent application layer — CLI
entry (single print mode), AgentSession orchestration over the agent loop, the
builtin coding tools (read/bash/edit/write/grep/find/ls), the JSONL session
manager, and system-prompt assembly.

**Layering deviation (deliberate):** unlike the other reduced copies, this one
imports its sibling reduced copies via relative paths — the agent loop from
`../../agent/src/index.ts` and (in tests + json-event) the faux provider from
`../../ai/src/index.ts`. Re-porting the 1.9k-line loop would duplicate
`reduced/agent`; importing it mirrors the real package layering
(pi-ai -> pi-agent-core -> pi-coding-agent).

## Run

```sh
node node_modules/vitest/dist/cli.js --run reduced/coding-agent/test/prompt.test.ts reduced/coding-agent/test/print-mode.test.ts reduced/coding-agent/test/json-event.test.ts
```

11 tests, fully offline via the faux provider. Typecheck with a throwaway
tsconfig extending `tsconfig.base.json` (`lib: ["ES2024"]`); `reduced/` is
outside the root tsconfig and biome scope.

## Main flow

```
main(argv) -> parseArgs -> settings -> SessionManager.create(cwd) (or in-memory)
  └─ createAgentSession({cwd, apiKey, model, baseTools?, tools?, streamFn...})
       ├─ tool defs: createAllTools(cwd) (or baseTools) filtered by name
       ├─ Agent { initialState, convertToLlm, streamFn }
       │    └─ transcript restored from sessionManager.buildSessionContext()
       └─ AgentSession        subscribes agent events -> persists on message_end
prompt(text)
  └─ queue-if-streaming (steer/followUp) | user message +
     system-prompt sections diff (diffSystemPromptSections) prepended
     + agent.state.tools refresh -> agent.prompt
       └─ agent loop: LLM -> coding tools (read/bash/edit/write/grep/find/ls)
          -> toolResults -> repeat
runPrintMode(session, {mode: "text"|"json", messages})   prints answer or JSON events
```

## File map (reduced -> real source, and what was trimmed)

| Reduced (lines) | Real source (lines) | Trimmed |
|---|---|---|
| `src/core/agent-session.ts` (652) | `core/agent-session.ts` (3625) | extensions (all binding/interception/events), compaction, auto-retry, tree navigation/fork, bash `!` execution, skills/templates, scoped models, stats/exports dropped; prompt pipeline, persistence, tool loadout + sections diff, model/thinking management verbatim |
| `src/core/session-manager.ts` (819) | `core/session-manager.ts` (1786) | tree/branch/fork/labels/listing/discovery and compaction/branch-summary/custom entry types dropped; JSONL format v3, deferred flush until first assistant message, context replay, migrations verbatim |
| `src/core/system-prompt.ts` (~200) | `core/system-prompt.ts` (216) | skills section + forced-prompt plumbing dropped; sections + diff protocol verbatim |
| `src/core/messages.ts` (62) | `core/messages.ts` (196) | custom roles (bashExecution/branchSummary/compactionSummary) dropped; `convertToLlm` boundary + SystemMessage sections merging kept |
| `src/core/tools/` (2541) | `core/tools/` + renderers (4884) | powershell, renderers (8 files), image support, exec.ts/bash-executor.ts, macOS path variants, diff patch/preview dropped; multi-edit semantics, truncation, rg/fd, mutation queue, kill-tree bash verbatim |
| `src/core/sdk.ts` (~190) | `core/sdk.ts` (410) | auth.json/models.json/ModelRuntime/resource loader/extensions dropped; `createAgentSession` wires tools + session + Agent directly |
| `src/{args,cli,config,settings}.ts` + `core/defaults.ts` (~280) | `main.ts`+`cli/args.ts`+`config.ts` (~2000) | single print mode; auth/package/config subcommands, fork/resume/continue flags, trust, self-update dropped |
| `src/modes/{print-mode,json-event}.ts` (152) | `modes/` (~1100 for print+json) | TUI (interactive ~14k), rpc (~1.4k), experimental workers (~6k) dropped; `json-event.ts` byte-faithful |
| `src/index.ts` (98) | `index.ts` (440) | barrel |
| `test/` (461) | `test/suite/` (~10k relevant) | 4 files: slimmed harness (faux provider), prompt subset, print-mode, merged json-event regressions; retry/queue/runtime-machinery suites dropped with the features |

Totals: reduced src ~4939 lines vs 71.9k.

## Intentionally dropped (with rationale)

- **modes/interactive** (TUI ~14k with components/theme), **modes/rpc**,
  **experimental/** (session workers, relay, micro) — alternative front-ends.
- **extensions system** (types/runner/loader ~3k + bindings everywhere) —
  plugin machinery, not main flow.
- **compaction** (~1k in coding-agent) — harness-level concern; also dropped
  from reduced/agent.
- **settings-manager/auth-storage/model-registry/resolver/package-manager/
  trust/resource-loader** (~8k) — configuration and provider-catalog plumbing;
  the reduced copy takes `apiKey` + `model` directly.
- **Windows/PowerShell tool paths** — POSIX-only per the provider/language
  trim directive.

The two pi-agent-core contracts this layer depends on are preserved verbatim:
the `Agent` loop surface (prompt/continue/steer/followUp/subscribe/
state.tools/convertToLlm/streamFn) and the `SystemMessage.sections` diff
protocol for tool-loadout and prompt updates.
