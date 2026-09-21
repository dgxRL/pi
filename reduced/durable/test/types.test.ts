// Ported from packages/durable/test/types.test.ts. Pruned: the DocumentRecord/
// DocumentCreate assertions (the reduced copy drops the type-only document
// schema); all kept assertions preserve the original semantics.

import { expectTypeOf, it } from "vitest";
import type { ContextEdit, Input, TaskOutcome, TaskRecord, TaskState } from "../src/index.ts";

it("encodes discriminator-dependent fields", () => {
	const omit = { target: 1, action: "omit" } satisfies ContextEdit;
	const replace = { target: 1, action: "replace", messages: [] } satisfies ContextEdit;
	const pending = { status: "pending", checkpoint: { phase: "ready" } } satisfies TaskState<
		{ phase: string },
		{ value: number }
	>;
	const terminal = {
		status: "terminal",
		outcome: { status: "completed", result: { value: 1 } },
	} satisfies TaskState<{ phase: string }, { value: number }>;

	expectTypeOf(omit.action).toEqualTypeOf<"omit">();
	expectTypeOf(replace.action).toEqualTypeOf<"replace">();
	expectTypeOf(pending.status).toEqualTypeOf<"pending">();
	expectTypeOf(terminal.status).toEqualTypeOf<"terminal">();

	const compileTimeFailures = () => {
		// @ts-expect-error replacement edits require replacement messages
		const missingReplacement: ContextEdit = { target: 1, action: "replace" };
		// @ts-expect-error omission edits cannot carry replacement messages
		const omissionWithMessages: ContextEdit = { target: 1, action: "omit", messages: [] };
		// @ts-expect-error pending task state cannot carry an outcome
		const pendingWithOutcome: TaskState<{ phase: string }, number> = { status: "pending", checkpoint: { phase: "ready" }, outcome: { status: "completed", result: 1 } };
		// @ts-expect-error terminal task state cannot retain a live checkpoint
		const terminalWithCheckpoint: TaskState<{ phase: string }, number> = {
			status: "terminal",
			outcome: { status: "completed", result: 1 },
			checkpoint: { phase: "ready" },
		};
		// @ts-expect-error terminal task records cannot retain live memos
		const terminalWithMemos: TaskRecord<null, { phase: string }, number> = {
			id: 1,
			conversationId: 1,
			kind: "test.task",
			version: 1,
			input: null,
			after: [],
			background: false,
			abortRequested: false,
			state: { status: "terminal", outcome: { status: "completed", result: 1 } },
			memos: { key: "value" },
		};
		// @ts-expect-error completed outcomes cannot carry errors
		const completedWithError: TaskOutcome<number> = {
			status: "completed",
			result: 1,
			error: { message: "no" },
		};
		// @ts-expect-error queued inputs cannot reference transcript entries
		const queuedWithEntry: Input = { id: 1, conversationId: 1, status: "queued", entry: 2 };
		void [
			pendingWithOutcome,
			terminalWithCheckpoint,
			terminalWithMemos,
			completedWithError,
			queuedWithEntry,
		];
	};

	expectTypeOf(compileTimeFailures).toBeFunction();
});
