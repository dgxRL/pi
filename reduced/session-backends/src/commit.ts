import type { CommitResult, Entry, EntryWrite, NewEntry, Write } from "./types.ts";
import type { ListAppendWrite, ListDeleteWrite, ValueSetWrite, ValueDeleteWrite } from "./values.ts";

export type CommittedEntryWrite = Entry & { kind: "entry" };
export interface CommittedValueSetWrite {
	kind: "value";
	op: "set";
	seq: number;
	namespace: string;
	key: string;
	value: unknown;
}
export interface CommittedValueDeleteWrite {
	kind: "value";
	op: "delete";
	seq: number;
	namespace: string;
	key: string;
}
export interface CommittedListAppendWrite {
	kind: "list";
	op: "append";
	seq: number;
	namespace: string;
	key: string;
	value: unknown;
}
export interface CommittedListDeleteWrite {
	kind: "list";
	op: "delete";
	seq: number;
	namespace: string;
	key: string;
}
export type CommittedWrite =
	| CommittedEntryWrite
	| CommittedValueSetWrite
	| CommittedValueDeleteWrite
	| CommittedListAppendWrite
	| CommittedListDeleteWrite;

export interface PreparedCommit {
	writes: CommittedWrite[];
	result: Omit<CommitResult, "stats">;
}

export function insertEntry(entry: NewEntry): EntryWrite {
	return { kind: "entry", entry };
}

export function commitWrite(write: Write, seq: number, timestamp: number): CommittedWrite {
	switch (write.kind) {
		case "entry":
			return { kind: "entry", ...write.entry, seq, timestamp };
		case "value":
			return write.op === "set"
				? { kind: "value", op: "set", seq, namespace: write.namespace, key: write.key, value: write.value }
				: { kind: "value", op: "delete", seq, namespace: write.namespace, key: write.key };
		case "list":
			return write.op === "append"
				? { kind: "list", op: "append", seq, namespace: write.namespace, key: write.key, value: write.value }
				: { kind: "list", op: "delete", seq, namespace: write.namespace, key: write.key };
	}
}

/** Assigns consecutive sequences `firstSeq..` and stamps every write with `timestamp`. */
export function prepareStorageCommit(writes: Write[], firstSeq: number, timestamp: number): PreparedCommit {
	const committedWrites = writes.map((write, index) => commitWrite(write, firstSeq + index, timestamp));
	return {
		writes: committedWrites,
		result: { firstSeq, seqs: committedWrites.map((write) => write.seq), timestamp },
	};
}
