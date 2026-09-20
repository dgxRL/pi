# types.ts — relationship diagram

Layer 1 of `reduced/session-backends/src` is the contract: data shapes that move
through storage, and the three API tiers (`Storage` -> `Session` -> `SessionRepo`)
that consume them. Two views below; all names live in `src/types.ts` (address
shapes in `src/values.ts`).

Arrows: `--|>` inheritance/extends, `-->` references/holds, `..>` uses/produces.

## Data shapes

`Entry` is the union of the three entry kinds; every entry is a node in a tree
via `parentId`. A commit (`Write`) applies one or more of: a new entry
(`EntryWrite`, later stamped with `seq`/`timestamp`), a scalar value set/delete,
or a list append/delete. `CommitResult` reports the assigned sequences plus the
post-commit `SessionStats`.

```mermaid
classDiagram
direction LR

class EntryBase {
  +id
  +parentId
  +seq
  +timestamp
  +type
}
class MessageEntry {
  +message
}
class CompactionEntry {
  +summary
  +retainedTail
  +tokensBefore
  +fromHook
}
class CustomEntry {
  +customType
  +data
}
class AgentMessage {
  +role
  +content
  +timestamp
}
class EntryWrite {
  +kind entry
  +entry NewEntry
}
class ValueSetWrite {
  +op set
  +namespace
  +key
  +value
}
class ValueDeleteWrite {
  +op delete
  +namespace
  +key
}
class ListAppendWrite {
  +op append
  +namespace
  +key
  +value
}
class ListDeleteWrite {
  +op delete
  +namespace
  +key
}
class CommitResult {
  +firstSeq
  +seqs
  +timestamp
}
class SessionStats {
  +messageCount
}
class Value~T~ {
  +namespace
  +key
}
class ValueList~T~ {
  +namespace
  +key
}
class StoredValue~T~ {
  +address
  +value
  +seq
}
class ListElement~T~ {
  +seq
  +value
}

EntryBase <|-- MessageEntry
EntryBase <|-- CompactionEntry
EntryBase <|-- CustomEntry
MessageEntry --> AgentMessage
EntryWrite ..> EntryBase : wraps NewEntry
ValueSetWrite ..> Value~T~ : sets
ValueDeleteWrite ..> Value~T~ : deletes
ListAppendWrite ..> ValueList~T~ : appends
ListDeleteWrite ..> ValueList~T~ : clears
StoredValue~T~ ..> Value~T~ : addressed by
ListElement~T~ ..> ValueList~T~ : element of
CommitResult ..> SessionStats : carries
```

Notes not expressible in the diagram:

- `Entry = MessageEntry or CompactionEntry or CustomEntry` (a type union, not a class).
- `Write = EntryWrite or ValueWrite or ListWrite`, where `ValueWrite` is the
  `ValueSetWrite`/`ValueDeleteWrite` pair and `ListWrite` the append/delete pair.
- `NewEntry` is `Entry` minus `seq`/`timestamp` — what a caller supplies before
  storage assigns positions.
- Well-known addresses (in `values.ts`): `branchTip(branch)`, `sessionName`,
  `entryLabel(id)` — branch tips are ordinary scalar values under `pi.branch.tip`.

## API tiers

`Storage` is the raw row store. `Session`/`SessionMutation`/`Branch` wrap it
behind a serialized mutation line. `SessionRepo` manages the lifecycle
(create/open/list/delete/fork). Both `Session` and `SessionMutation` extend the
same `SessionReader` read surface; the reduced `Branch` is write+read for one
named branch.

```mermaid
classDiagram
direction TB

class Storage {
  <<interface>>
  +commit(writes, context) CommitResult
  +getEntries(ids, context) Map
  +getValue(address, context) StoredValue
  +scanValues(prefix, context) array
  +readList(address, options, context) array
  +scanBranch(query, context) array
  +scanEntries(query, context) array
  +getStats(context) SessionStats
  +close(context)
}
class SessionReader {
  <<interface>>
  +getEntries(ids, context) Map
  +getStats(context) SessionStats
  +getValue(address, context) StoredValue
  +scanValues(prefix, context) array
  +readList(address, options, context) array
  +scanBranch(query, context) array
}
class SessionMutation {
  <<interface>>
  +commit(writes, context) CommitResult
  +end(context)
}
class Session {
  <<interface>>
  +metadata SessionMetadata
  +idGenerator IdGenerator
  +getEntry(id, context) Entry
  +getName(context) string
  +getLabel(targetId, context) string
  +findEntries(query, context) array
  +branch(name, context) Branch
  +createBranch(name, at, context) Branch
  +beginMutation(context) SessionMutation
  +mutate(callback, context) T
  +setValue(address, next, context)
  +deleteValue(address, context)
  +appendList(address, element, context)
  +setName(name, context)
  +setLabel(targetId, label, context)
  +close(context)
}
class Branch {
  <<interface>>
  +name
  +getTipId(context) string
  +findEntries(query, context) array
  +appendMessage(message, context) string
  +appendCustomEntry(customType, data, context) string
}
class SessionMetadata {
  +id
  +createdAt
  +parentSessionId
}
class SessionRepo {
  <<interface>>
  +create(options, context) Session
  +open(metadata, context) Session
  +list(options, context) array
  +delete(metadata, context)
  +fork(source, options, context) Session
}
class IdGenerator {
  +next() string
}
class Context {
  <<interface>>
}
class ForkOptions {
  +scope branch or tree
  +branch
  +entryId
  +id
}

Session --|> SessionReader
SessionMutation --|> SessionReader
Session --> Branch : branch or createBranch
Session --> SessionMetadata : metadata
Session --> IdGenerator : idGenerator
Session --> SessionMutation : beginMutation
Session --> Context : every call
SessionRepo --> Session : create, open, fork
SessionRepo --> SessionMetadata : open, delete, fork source
SessionRepo --> ForkOptions : fork
Branch ..> SessionReader : reads its branch
Storage ..> SessionReader : same read surface
```

## How the layers connect

- `SqliteStorage` (src/storage.ts) implements `Storage`; `StorageBackedSession`
  (src/session.ts) implements `Session` over it; `SqliteSessionRepo`
  (src/repo.ts) implements `SessionRepo`, and extends `SessionMetadata` with
  `path` (`SqliteSessionMetadata`, src/session-row.ts).
- `Context` is an opaque marker here (src/context.ts); the real package carries
  an abort signal and keyed values.
