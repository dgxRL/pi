# reduced/client

Standalone educational extraction of `packages/client` (`@earendil-works/
pi-client`, 1135 src lines): the transport-neutral client for remote pi
sessions — hello-fenced connections, request/response with cancellation,
service subscriptions with snapshot hydration, and a Unix-socket byte
transport.

**Layering deviation (deliberate):** imports sibling reduced copies via
relative paths — the wire protocol from `../../protocol/src/index.ts` and the
service/replicated-state contract + delta apply from `../../chord/src/index.ts`.
The service wire codec (`src/chord-wire.ts`) lives HERE because the client is
the transport-side consumer chord's reduced copy dropped it for.

## Run

```sh
node node_modules/vitest/dist/cli.js --run reduced/client/test/client.test.ts reduced/client/test/unix-transport.test.ts
```

18 tests, fully offline (an in-memory byte server + a real Unix socket).
Typecheck with a throwaway tsconfig extending `tsconfig.base.json`
(`lib: ["ES2024"]`); `reduced/` is outside the root tsconfig and biome scope.

## Main flow

```
Client.connect({ serverId, transportFactory })
  └─ Connection: hello exchange (version + serverId fencing)
       ├─ request(target, call, signal?)   id-correlated response, cancel on abort
       ├─ serviceCatalogue(target)
       └─ subscribeService(target, serviceId, mode, listener)
            └─ snapshot request -> queued updates apply after hydration
               -> start() -> ordered delivery (deliveryTail chain)
createClientServiceTransport(client, getTarget)   adapts Client -> RemoteServiceTransport
createUnixTransportFactory({ path })               the concrete byte transport
```

## File map (reduced -> real source, and what was trimmed)

| Reduced (lines) | Real source (lines) | Trimmed |
|---|---|---|
| `src/client.ts` (436) | `src/client.ts` (479) | attachment routing state dropped (the reduced protocol has no attachment envelope): `onAttachmentChange`, `#setAttachment`, attachment-aware target currency — targets validate against the hello serverId |
| `src/connection.ts` (258) | `src/connection.ts` (245) | verbatim (+`Promise.withResolvers` inline) |
| `src/chord-wire.ts` (246) | chord `services/wire.ts` (234) + `state-codec.ts` (158) | the service-call/snapshot/update codec the transport side needs; WireOp interning dropped (plain `Op[]` on the wire, ops validated by apply) so the "decoder" is shape validation + pass-through |
| `src/unix.ts` (93) | `src/unix.ts` (299) | `discoverUnixServers` + probe workers + timeout error taxonomy dropped; Windows guards dropped; write drain bookkeeping simplified to the write callback (ordering kept via serialized tail) |
| `src/{types,transport,errors}.ts` (79) | same (66) | near-verbatim; attachment listener type dropped |
| `src/promise.ts` (16) | `src/promise.ts` (16) | replaced by `Promise.withResolvers` |
| `test/` (585) | same (799) | attachment-based test setups rewritten to plain server targets, wire ops rewritten to plain `Op[]` form, discovery tests dropped with the feature |

Totals: reduced ~1734 lines vs 1934 (src + test).

## Intentionally dropped (with rationale)

- **Server discovery** (`discoverUnixServers`): probing `.sock` files with
  concurrent workers and a timeout error taxonomy — platform/deployment
  machinery, not the client protocol.
- **Attachment routing**: out-of-band session-route updates were already
  dropped from `reduced/protocol`; the client cannot track what the wire no
  longer carries.
- **Write backpressure accounting** (`maxPendingBytes`): socket write
  callbacks serialize sends; the bounded-pending limit is QoS armor.

The request/response pipeline (id correlation, cancellation frames, disconnect
rejection, hello fencing, framing validation) is preserved verbatim and pinned
by the ported tests.

## Cross-copy notes

- `reduced/protocol` and `reduced/chord` define structurally identical but
  nominally distinct `JsonValue` — chord's was aligned to protocol's
  `readonly` arrays so values cross the seam without casts.
- `chord-wire.ts` is the client-side half of the service wire protocol; the
  server side is chord's `RemoteServiceProvider` (serving `invoke`/`subscribe`
  for the `$chord.service` control service).
