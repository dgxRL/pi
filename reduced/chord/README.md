# reduced/chord

Standalone educational extraction of `packages/chord` (chord, 6270 src lines):
the application-composition runtime — explicit context propagation, a JSON
delta protocol, replicated state, remote services over a pluggable transport,
and the facet host that wires them together. No external npm deps, no Node
bundler machinery, no wire byte-codec.

## Run

```sh
node node_modules/vitest/dist/cli.js --run reduced/chord/test/context.test.ts reduced/chord/test/delta.test.ts reduced/chord/test/services.test.ts reduced/chord/test/facets.test.ts
```

29 tests. Typecheck with a throwaway tsconfig extending `tsconfig.base.json`
(`lib: ["ES2024"]` for `Promise.withResolvers`); `reduced/` is outside the root
tsconfig and biome file list.

## Main flow

```
defineFacet -> createFacetHost({ facets })
  └─ FacetKernel.activate(): setup() stages provides/uses -> topological order
     -> install implementations -> RemoteServiceProvider serves them
       ├─ provide(s)             singleton implementation
       ├─ provideMany(s).spawn() keyed instances
       └─ env.replicatedState()  tracked state; publish() emits delta ops

createRemoteServiceBinding({ services, transport })     consumer side
  └─ use(s)        local proxy: methods -> transport.invoke(call)
       ├─ observe(s, handler)  per-instance snapshots + updates
       └─ state members        replica hydrated from base ops, updated incrementally

transport = createLoopbackServiceTransport(host.services)   in-process seam
delta protocol: mutate a tracked proxy -> flush() -> Op[] -> apply on replica
```

## File map (reduced -> real source, and what was trimmed)

| Reduced (lines) | Real source (lines) | Trimmed |
|---|---|---|
| `src/types.ts` (190) | `src/types.ts` (261) | `RemoteServiceContract` conditional-type machinery, `JsonRepresentation`, `RemoteServiceSource` (multi-source hosts) dropped; `FacetHost.services` typed `RemoteServices & RemoteServiceTransport` |
| `src/context.ts` (122) | `src/context/index.ts` (121) | verbatim (`Promise.withResolvers` per repo rule) |
| `src/delta.ts` (355) | `src/delta/index.ts` (1715) | Op vocabulary + `apply`/`applyImmutable` verbatim; the 890-line coalescing tracker (trie/tombstones/string anchors) replaced by a direct-recording proxy tracker with the same `Tracker` surface; `WireOp` interning + `Encoder`/`decoder` (wire compression), prototype-pollution guards, and validation armor dropped |
| `src/services/state.ts` (156) | `src/services/state.ts` (139) + `state-codec.ts` (158) + `state-internals.ts` (20) | codec dropped (transports own framing; updates carry `Op[]` directly) |
| `src/services/provider.ts` (520) | `src/services/provider.ts` (586) | `createRemoteServiceEndpoint` (byte-transport adapter), `validateRemoteServiceImplementation`, replacement-validation armor dropped |
| `src/services/consumer.ts` (657) | `src/services/consumer.ts` (660) | retry/batching/reconnect edge machinery dropped; loopback main flow verbatim |
| `src/services/loopback.ts` (28) | `src/services/loopback.ts` (17) | structural `ServiceProviderServing` type so the host facade or the provider class both plug in |
| `src/services/{errors,handle,instances}.ts` (196) | same (192) | near-verbatim |
| `src/facets.ts` (874) | `src/facets/host.ts` (906) + `loader.ts` (6) | `RemoteServiceSource`/`serviceSources` multi-source machinery, deferred/absent-service placeholders, diagnostics dropped |
| `src/api.ts` (73) | `src/api.ts` (90) | `defineService` conditional overloads dropped |
| `src/index.ts` (57) | `src/index.ts` (79) | barrel |

Not ported: `src/node/*` (bundle loader, package manifests — esbuild/Node
runtime packaging) and `src/bundler.ts`, `src/compat/*` — the Node/ecosystem
specific layer. Totals: reduced src ~3328 lines vs 6270; the test bundle is
pruned to main-flow contracts (wire-codec and state-codec coverage dropped
with the codecs).

## Simplifications

- Delta tracker records one op per write (whole-value `s` on set, `d` on
  delete); no coalescing, so string appends record as whole-string sets and
  array pushes as element + length sets. The `a`/`t`/`p` op kinds stay in the
  vocabulary and replicas apply them — producers just emit simpler ops.
- No byte wire: `RemoteServiceTransport` implementations pass `ServiceCall` /
  `ServiceProviderUpdate` objects; the loopback is the reference seam.
- `FacetHost.services` exposes local consumption (`use`/`observe`/`ready`/
  `dispose`) plus the serving side (`invoke`/`subscribe`) so any transport can
  be built directly on the host.
- No `RemoteServiceSource` pluggability: the host serves exactly what its
  facets provide.

Remaining `try`/guard blocks are load-bearing: loader cleanup-on-failure
(pinned by `combineFacetLoaders` semantics), delta apply parent checks, and
`RemoteServiceError` propagation through the binding.
