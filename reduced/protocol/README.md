# reduced/protocol

Standalone educational extraction of `packages/protocol` (`@earendil-works/
pi-protocol`, 869 src lines): the transport-neutral remote-session wire
protocol — typed message envelopes, a strict CBOR subset codec, and
length-prefixed framing. Deps: `typebox` (schema validation); everything else
is local (chord's `isJsonValue`/`JsonValue` reduced into `src/json.ts`).

## Run

```sh
node node_modules/vitest/dist/cli.js --run reduced/protocol/test/framing.test.ts reduced/protocol/test/protocol.test.ts
```

50 tests. Typecheck with a throwaway tsconfig extending `tsconfig.base.json`
(`lib: ["ES2024"]`); `reduced/` is outside the root tsconfig and biome scope.

## Main flow

```
encodeClientMessage(msg)              validate (typebox + strict JSON)
  └─ encodeFrame(encodeCbor(msg))     CBOR bytes + 4-byte big-endian length prefix
ClientMessageDecoder.push(chunk)      arbitrary byte chunks -> validated messages
  └─ FrameDecoder                     incremental re-framing across chunk boundaries
  └─ decodeCbor + parseClientMessage  strict CBOR subset + schema validation
protocol: hello/version fencing -> request/cancel envelopes -> responses/events
```

## File map (reduced -> real source, and what was trimmed)

| Reduced (lines) | Real source (lines) | Trimmed |
|---|---|---|
| `src/protocol.ts` (95) | `src/protocol.ts` (110) | `AttachmentEnvelope` dropped (out-of-band presentation routing — remote-client plumbing); hello fencing, request/cancel/response/service_update envelopes verbatim |
| `src/codec.ts` (141) | `src/codec.ts` (141) | verbatim; `isJsonValue` from the local stand-in |
| `src/framing.ts` (151) | `src/framing.ts` (151) | verbatim |
| `src/cbor/{options,encoder,decoder}.ts` (436) | same (436) | verbatim |
| `src/json.ts` (27) | chord `isJsonValue` | reduced; cycle detection kept (pinned by a test) |
| `test/` (550) | same (567) | only the dropped attachment-envelope test removed |

Totals: reduced ~1000 lines vs 1436 (src + test).

## Concept notes

- **Strict CBOR subset** (RFC 8949): definite lengths only, no tags, no
  indefinite items, safe integers only, finite numbers as float64, string map
  keys, no cycles/holes/undefined. All limits (byte length, container length,
  depth) bound untrusted payloads and are part of the contract.
- **Framing**: unsigned 32-bit big-endian length prefix; `FrameDecoder`
  reassembles frames across arbitrary chunk boundaries with bounded blocks.
- **Fencing**: every RPC carries an `RpcTarget` — either server-wide
  (`serverId`) or session-scoped (`serverId` + `sessionId` + `attachmentId`) —
  and both sides gate on one protocol version via the hello exchange.
