# Messages, events, streams — dependency and flow

The three families in `reduced/agent/src`:

- **Messages** (`types.ts`): the transcript. `Message` = system / user / assistant / toolResult; `AgentMessage` adds app-defined custom messages via declaration merging.
- **Events** (`types.ts`): two protocols. `AssistantMessageEvent` — deltas inside one assistant stream; `AgentEvent` — the 10-kind lifecycle the loop emits to the UI.
- **Streams** (`event-stream.ts`, `stream-fn.ts`, `types.ts`): `EventStream<T, R>` buffered async iteration; `AssistantMessageEventStream` completes on `done`/`error` and extracts the final `AssistantMessage`; `StreamFn` produces one per model request.

Arrows: `--|>` extends, `-->` holds/references, `..>` uses/produces.

## Type dependencies

```mermaid
classDiagram
direction TB

class Message {
  <<union>>
}
class SystemMessage {
  +role system
  +content
}
class UserMessage {
  +role user
  +content
}
class AssistantMessage {
  +role assistant
  +content
  +stopReason
  +usage
}
class ToolResultMessage {
  +role toolResult
  +toolCallId
  +content
}
class AgentMessage {
  <<union>>
}
class AssistantMessageEvent {
  <<union>>
  start text_start text_delta text_end
  toolcall_start toolcall_delta toolcall_end
  done error
}
class AgentEvent {
  <<union>>
  agent_start agent_end
  turn_start turn_end
  message_start message_update message_end
  tool_execution_start tool_execution_update tool_execution_end
}
class EventStream~T,R~ {
  +push(event)
  +end(result)
  +result() Promise~R~
}
class AssistantMessageEventStream
class StreamFn {
  <<type>>
}
class AgentLoopConfig {
  <<interface>>
  +convertToLlm
  +transformContext
  +getSteeringMessages
  +getFollowUpMessages
}
class AgentLoop["AgentLoop (agent-loop.ts)"]
class Agent["Agent (agent.ts)"]

SystemMessage ..> Message : union member
UserMessage ..> Message : union member
AssistantMessage ..> Message : union member
ToolResultMessage ..> Message : union member
AgentMessage ..> Message : Message or custom
AssistantMessageEvent ..> AssistantMessage : partial and done message
AssistantMessageEventStream --|> EventStream : T AssistantMessageEvent R AssistantMessage
StreamFn ..> AssistantMessageEventStream : returns
StreamFn ..> Message : consumes context messages
AgentLoopConfig ..> StreamFn : streamFn
AgentLoopConfig ..> AgentMessage : convertToLlm output
AgentLoop ..> AgentEvent : emits into EventStream
AgentLoop ..> AssistantMessageEvent : pumps stream events
Agent ..> AgentEvent : processEvents consumes
Agent ..> AgentMessage : transcript state
```

Notes not expressible in the diagram:

- `Message` and `AgentMessage` are type unions, not classes. `AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages]`.
- `EventStream<AgentEvent, AgentMessage[]>` is also the public return type of `agentLoop()` / `agentLoopContinue()` — the same stream class instantiated twice with different payloads.
- `AgentEvent.message_update` is the only event that carries an `AssistantMessageEvent`; it forwards every text/toolcall stream event verbatim.

## Runtime flow

One run from `Agent.prompt()` (or bare `runAgentLoop`) to `agent_end`. The stream carries `AssistantMessageEvent`s; the loop turns them into an `AssistantMessage` plus `AgentEvent`s; the wrapper reduces those into state and listener calls.

```mermaid
flowchart TD
    P["Agent.prompt / continue"] --> RAL["runAgentLoop<br/>agent_start - turn_start<br/>message_start - message_end per prompt"]
    RAL --> POLL["runLoop turn setup<br/>steering poll - prepareNextTurn<br/>inject queued messages"]
    POLL --> TC["transformContext<br/>AgentMessage array to AgentMessage array"]
    TC --> CV["convertToLlm<br/>AgentMessage array to Message array"]
    CV --> SF["streamFn model - messages - apiKey - signal"]
    SF --> AMS["AssistantMessageEventStream"]
    AMS --> PUMP["event pump for-await"]
    PUMP -->|"start"| MS["push partial into context.messages<br/>emit message_start"]
    PUMP -->|"text and toolcall deltas"| MU["replace last partial<br/>emit message_update wrapping the stream event"]
    PUMP -->|"done or error"| ME["await result final AssistantMessage<br/>replace partial - emit message_end"]
    ME --> TOOLS{"tool calls and stopReason not length"}
    TOOLS -->|"yes"| EXE["executeToolCalls<br/>beforeToolCall - execute - afterToolCall<br/>tool_execution_start / update / end<br/>append ToolResultMessage"]
    TOOLS -->|"no or length"| TE["emit turn_end"]
    EXE --> TE
    TE --> STOP{"shouldStopAfterTurn<br/>steering - followUp poll"}
    STOP -->|"more to do"| POLL
    STOP -->|"stop"| END["emit agent_end messages"]
    END --> RED["Agent.processEvents<br/>reduce AgentEvent to state<br/>then await each listener"]

    RED -.->|"state: transcript - streamingMessage - pendingToolCalls"| W["Agent state"]
```

Exit conditions (all reach `agent_end`): no tool calls and no queued steering/follow-ups; `shouldStopAfterTurn` returns true; every tool result in the batch sets `terminate`; the stream settles with stopReason `error`/`aborted` (that assistant message becomes the final turn). A thrown run is converted by `Agent.handleRunFailure` into a synthetic error/aborted assistant message plus the full `message_start` -> `message_end` -> `turn_end` -> `agent_end` sequence.

## Event ordering in one turn

The interleaving of stream events, transcript mutation, and `AgentEvent`s:

```mermaid
sequenceDiagram
    participant S as AssistantMessageEventStream
    participant L as agent-loop runLoop
    participant A as Agent processEvents

    L->>S: streamFn result
    S->>L: start (partial)
    L->>A: message_start (copy of partial)
    Note over L: context.messages gets the live partial
    S->>L: text_start / text_delta / text_end
    L->>A: message_update (wraps AssistantMessageEvent)
    S->>L: toolcall_start / toolcall_delta / toolcall_end
    L->>A: message_update
    S->>L: done (reason) or error
    L->>S: await result()
    S-->>L: final AssistantMessage
    L->>A: message_end (final message)
    L->>A: tool_execution_start / update / end per call
    L->>A: message_start + message_end per ToolResultMessage
    L->>A: turn_end (message, toolResults)
    Note over L,A: repeats while tool calls remain or steering is queued
    L->>A: agent_end (messages)
```

- `message_start`/`message_update` carry shallow copies; only `message_end` appends the final message to `Agent` state (`processEvents`).
- Tool result messages are emitted after the whole batch finalizes (in assistant source order); `tool_execution_end` may arrive earlier, in completion order.
- There is exactly one `turn_start` per turn: emitted by `runAgentLoop` for the first turn, then by `runLoop` for every subsequent turn (after `prepareNextTurn`).
