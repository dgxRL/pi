// Typed storage addresses and write builders, reduced from pi-agent-core.
// An address is (namespace, key, kind); values are JSON blobs keyed by address.

export interface StoredAddressBase {
	readonly namespace: string;
	readonly key: string;
	readonly kind: "value" | "list";
}

export interface Value<T> extends StoredAddressBase {
	readonly kind: "value";
}

export interface ValueList<T> extends StoredAddressBase {
	readonly kind: "list";
}

export interface StoredValue<T> {
	address: Value<T>;
	value: T;
	seq: number;
}

export interface ListElement<T> {
	seq: number;
	value: T;
}

export interface ListCursor {
	seq: number;
}

export interface ListReadOptions {
	cursor?: ListCursor;
	order?: "asc" | "desc";
	limit?: number;
}

export interface ResolvedListReadOptions {
	cursor?: ListCursor;
	order: "asc" | "desc";
	limit: number;
}

export interface ValueSetWrite {
	kind: "value";
	op: "set";
	namespace: string;
	key: string;
	value: unknown;
}

export interface ValueDeleteWrite {
	kind: "value";
	op: "delete";
	namespace: string;
	key: string;
}

export interface ListAppendWrite {
	kind: "list";
	op: "append";
	namespace: string;
	key: string;
	value: unknown;
}

export interface ListDeleteWrite {
	kind: "list";
	op: "delete";
	namespace: string;
	key: string;
}

export type ValueWrite = ValueSetWrite | ValueDeleteWrite;
export type ListWrite = ListAppendWrite | ListDeleteWrite;

export function value<T>(namespace: string, key = ""): Value<T> {
	return { namespace, key, kind: "value" };
}

export function list<T>(namespace: string, key = ""): ValueList<T> {
	return { namespace, key, kind: "list" };
}

export function setValue<T>(address: Value<T>, next: NoInfer<T>): ValueSetWrite {
	return { kind: "value", op: "set", namespace: address.namespace, key: address.key, value: next };
}

export function deleteValue<T>(address: Value<T>): ValueDeleteWrite {
	return { kind: "value", op: "delete", namespace: address.namespace, key: address.key };
}

export function appendList<T>(address: ValueList<T>, element: NoInfer<T>): ListAppendWrite {
	return { kind: "list", op: "append", namespace: address.namespace, key: address.key, value: element };
}

export function deleteList<T>(address: ValueList<T>): ListDeleteWrite {
	return { kind: "list", op: "delete", namespace: address.namespace, key: address.key };
}

export function resolveListReadOptions(options: ListReadOptions = {}): ResolvedListReadOptions {
	return {
		...(options.cursor === undefined ? {} : { cursor: options.cursor }),
		order: options.order ?? "asc",
		limit: options.limit ?? 1_000,
	};
}

export const branchTip = (branch: string) => value<string | null>("pi.branch.tip", branch);
export const sessionName = value<string>("pi.session.name");
export const entryLabel = (entryId: string) => value<string>("pi.entry.label", entryId);
