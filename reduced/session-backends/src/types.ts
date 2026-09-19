import type { DatabaseSync } from "node:sqlite";
import type { Context } from "./context.ts";
import type {
	ListElement,
	ListReadOptions,
	ListWrite,
	StoredValue,
	Value,
	ValueList,
	ValueWrite,
} from "./values.ts";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Reduced from pi-ai: only the fields the tests exercise. */
export interface AgentMessage {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

export type EntryType = "message" | "compaction" | "custom";

export interface EntryBase {
	id: string;
	parentId: string | null;
	seq: number;
	timestamp: number;
	type: EntryType;
}

export interface MessageEntry extends EntryBase {
	type: "message";
	message: AgentMessage;
}

export interface CompactionEntry extends EntryBase {
	type: "compaction";
	summary: string;
	retainedTail: AgentMessage[];
	tokensBefore: number;
	fromHook: boolean;
}

export interface CustomEntry extends EntryBase {
	type: "custom";
	customType: string;
	data?: JsonValue;
}

export type Entry = MessageEntry | CompactionEntry | CustomEntry;

/** Entry supplied to a commit before storage assigns sequence and timestamp. */
export type NewEntry<TEntry extends Entry = Entry> = TEntry extends Entry ? Omit<TEntry, "seq" | "timestamp"> : never;

export interface EntryWrite {
	kind: "entry";
	entry: NewEntry;
}

export type Write = EntryWrite | ValueWrite | ListWrite;

export interface CommitResult {
	firstSeq: number;
	seqs: number[];
	timestamp: number;
	stats: SessionStats;
}

export interface EntryStructure {
	id: string;
	parentId: string | null;
	seq: number;
	timestamp: number;
	type: EntryType;
	customType?: string;
}

export interface EntryCursor {
	seq: number;
}

export interface BranchScan {
	start?: string;
	stopAtType?: EntryType;
	stopAtId?: string;
	type?: EntryType;
	customType?: string;
	order?: "newestFirst" | "oldestFirst";
	limit?: number;
	cursor?: EntryCursor;
}

export type StorageBranchScan = BranchScan & { start: string };

export interface EntryScan {
	type?: EntryType;
	customType?: string;
	fromSeq?: number;
	toSeq?: number;
	order?: "asc" | "desc";
	limit?: number;
}

export interface SessionStats {
	messageCount: number;
}

export interface Storage {
	commit(writes: Write[], context: Context): Promise<CommitResult>;
	getEntries(ids: string[], context: Context): Promise<Map<string, Entry>>;
	getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined>;
	scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]>;
	readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		context: Context,
	): Promise<ListElement<T>[]>;
	scanBranch(query: StorageBranchScan, context: Context): Promise<Entry[]>;
	scanEntries(query: EntryScan, context: Context): Promise<Entry[]>;
	getStats(context: Context): Promise<SessionStats>;
	close(context: Context): Promise<void>;
}

export interface SessionMetadata {
	id: string;
	createdAt: number;
	parentSessionId?: string;
}

export interface IdGenerator {
	next(): string;
}

export interface EntryQuery {
	type?: EntryType;
	customType?: string;
	order?: "asc" | "desc";
	limit?: number;
	cursor?: EntryCursor;
}

export interface SessionReader {
	getEntries(ids: string[], context: Context): Promise<Map<string, Entry>>;
	getStats(context: Context): Promise<SessionStats>;
	getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined>;
	scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]>;
	readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		context: Context,
	): Promise<ListElement<T>[]>;
	scanBranch(query: StorageBranchScan, context: Context): Promise<Entry[]>;
}

/** Exclusive mutation barrier for one Session. */
export interface SessionMutation extends SessionReader {
	commit(writes: Write[], context: Context): Promise<CommitResult>;
	end(context: Context): Promise<void>;
}

export type SessionMutator = Omit<SessionMutation, "end">;

export type SessionMutationCallback<T> = (mutator: SessionMutator, context: Context) => T | Promise<T>;

export interface Branch {
	readonly name: string;
	getTipId(context: Context): Promise<string | null>;
	findEntries(query: BranchScan | undefined, context: Context): Promise<Entry[]>;
	appendMessage(message: AgentMessage, context: Context): Promise<string>;
	appendCustomEntry(customType: string, data: JsonValue | undefined, context: Context): Promise<string>;
}

export interface Session<TMetadata extends SessionMetadata = SessionMetadata> extends SessionReader {
	readonly metadata: TMetadata;
	readonly idGenerator: IdGenerator;
	getEntry(id: string, context: Context): Promise<Entry | undefined>;
	getName(context: Context): Promise<string | undefined>;
	getLabel(targetId: string, context: Context): Promise<string | undefined>;
	findEntries(query: EntryQuery | undefined, context: Context): Promise<Entry[]>;
	branch(name: string, context: Context): Promise<Branch | undefined>;
	createBranch(name: string, at: string | null, context: Context): Promise<Branch>;
	beginMutation(context: Context): Promise<SessionMutation>;
	mutate<T>(mutation: SessionMutationCallback<T>, context: Context): Promise<T>;
	setValue<T>(address: Value<T>, next: NoInfer<T>, context: Context): Promise<void>;
	deleteValue<T>(address: Value<T>, context: Context): Promise<void>;
	appendList<T>(address: ValueList<T>, element: NoInfer<T>, context: Context): Promise<void>;
	setName(name: string | undefined, context: Context): Promise<void>;
	setLabel(targetId: string, label: string | undefined, context: Context): Promise<void>;
	close(context: Context): Promise<void>;
}

export interface SessionCreateOptions {
	id?: string;
	parentSessionId?: string;
}

export type ForkOptions =
	| { scope: "branch"; branch: string; entryId?: string; id?: string }
	| { scope: "tree"; id?: string };

export interface SessionRepo<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends { id?: string; parentSessionId?: string } = SessionCreateOptions,
	TListOptions = void,
> {
	create(options: TCreateOptions, context: Context): Promise<Session<TMetadata>>;
	open(metadata: TMetadata, context: Context): Promise<Session<TMetadata>>;
	list(options: TListOptions | undefined, context: Context): Promise<TMetadata[]>;
	delete(metadata: TMetadata, context: Context): Promise<void>;
	fork(source: TMetadata, options: ForkOptions, context: Context): Promise<Session<TMetadata>>;
}

/** The reduced copy talks to `node:sqlite` directly; no driver abstraction. */
export type SqliteDatabase = DatabaseSync;

export interface SqlRunResult {
	changes: number | bigint;
}
