import type { JsonValue } from "./types.ts";

export type { JsonValue } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// chord/delta — operation-log change tracking over plain JSON.
//
// Depends on nothing else in chord. Replicated state consumes it; keep the
// arrows pointing that way.
//
// Reduced copy: the op vocabulary and both appliers are the original logic.
// The tracker is a teaching version — one op per write, no coalescing. Wire
// compression (path interning, arity omission) is dropped entirely; transports
// own framing.
// ─────────────────────────────────────────────────────────────────────────────

export type Seg = string | number;
export type Path = readonly Seg[];
export type NonEmptyPath = readonly [Seg, ...Seg[]];

/**
 * Tuples are the form — in memory, on disk.
 *
 * `r` is the ONLY op that replaces a whole value. `s`/`d`/`a`/`t` cannot target
 * the root: the type forbids it. `p` may, because a tracked value can itself be
 * an array. Operation shape is not canonical: an array may be emptied by either
 * a replacement or a root splice.
 */
export type Op =
	| readonly ["r", JsonValue]
	| readonly ["s", NonEmptyPath, JsonValue]
	| readonly ["d", NonEmptyPath]
	| readonly ["a", NonEmptyPath, string]
	| readonly ["t", NonEmptyPath, number]
	| readonly ["p", Path, number, number, JsonValue[]];

// ─── Classification ──────────────────────────────────────────────────────────

export const isReplace = (op: Op): boolean => op[0] === "r";

/**
 * A batch begins with a replacement. Flush guarantees `r` is at index 0 or absent,
 * so this is exact rather than a heuristic.
 */
export const isBase = (ops: readonly Op[]): boolean => ops.length > 0 && ops[0]![0] === "r";

// ─── Tracker ─────────────────────────────────────────────────────────────────

export interface Tracker<T extends object> {
	/**
	 * The tracked value. Mutate and read state only through this proxy. Values
	 * inserted into it are adopted: callers may retain read-only references, but
	 * must not mutate them outside this proxy.
	 */
	state: T;
	/** The untracked current value. Mutating it bypasses change tracking. */
	readonly target: T;
	/** Return the ops recorded since the last flush, in write order, and clear them. */
	flush(): Op[];
	/** Make the next flush a complete base batch without changing the value. */
	rebase(): void;
	/** Accept pending mutations locally without emitting them. */
	discard(): void;
	/** Whether anything was written — or a base batch is still owed — since the last flush. */
	readonly dirty: boolean;
}

const isObj = (value: unknown): value is object => value !== null && typeof value === "object";

/**
 * A JSON-safe deep copy. Recorded ops snapshot values at write time, so a later
 * external mutation of an assigned object cannot corrupt what was recorded.
 */
const deepCopy = <T extends JsonValue>(value: T): T => {
	if (!isObj(value)) return value;
	if (Array.isArray(value)) return value.map((item) => deepCopy(item)) as unknown as T;
	const result = {} as Record<string, JsonValue>;
	for (const key of Object.keys(value)) {
		result[key] = deepCopy((value as Record<string, JsonValue>)[key]!);
	}
	return result as T;
};

const INDEX = /^(?:0|[1-9]\d*)$/;
const norm = (target: object, key: string): Seg =>
	Array.isArray(target) && INDEX.test(key) ? Number(key) : key;

/**
 * Record ops by mutating a proxy. Every `set` records a whole-value `s` at the
 * mutated path, every `delete` a `d` — no coalescing, so a burst of writes
 * flushes as one op per write. String appends therefore record as whole-string
 * sets and array growth as element/whole-array sets; the `a`/`t`/`p` op kinds
 * stay in the vocabulary and are exercised at the consumer. The production
 * tracker diffs instead and coalesces repeated writes; the contract — mutate a
 * proxy, flush ops a replica can apply — is identical.
 */
export function track<T extends object>(initial: T): Tracker<T> {
	const root = initial;
	let pending: Op[] = [];
	let hasPending = false;
	let forceBase = true;

	// Proxy -> raw target, so a proxy assigned back into the tree unwraps to the
	// value it tracks instead of nesting proxies inside the recorded state.
	const targets = new WeakMap<object, object>();

	const emit = (op: Op): void => {
		pending.push(op);
		hasPending = true;
	};

	const clearPending = (): void => {
		pending = [];
		hasPending = false;
	};

	const wrap = (target: object, path: Path): object => {
		const children = new Map<string | symbol, { raw: object; proxy: object }>();
		const proxy = new Proxy(target, {
			get(at, key) {
				if (typeof key === "symbol") return (at as Record<symbol, unknown>)[key];
				const value = (at as Record<string, unknown>)[key];
				if (!isObj(value)) return value;
				const cached = children.get(key);
				if (cached !== undefined && cached.raw === value) return cached.proxy;
				const child = wrap(value, [...path, norm(at, key)]);
				children.set(key, { raw: value, proxy: child });
				return child;
			},

			set(at, key, value) {
				// Symbols bypass tracking: paths are JSON, symbols are not.
				if (typeof key === "symbol") return Reflect.set(at, key, value);
				if (Array.isArray(at) && key === "length") {
					// A length write is a structural mutation; record the resulting array.
					Reflect.set(at, key, value);
					if (path.length === 0) emit(["r", deepCopy(root as unknown as JsonValue)]);
					else emit(["s", [...path] as unknown as NonEmptyPath, deepCopy(at as unknown as JsonValue)]);
					return true;
				}
				// Unwrap a nested proxy to its raw target, then snapshot the value: the
				// recorded op must not alias what the caller could mutate afterwards.
				const raw = isObj(value) ? (targets.get(value) ?? value) : value;
				emit(["s", [...path, norm(at, key)] as unknown as NonEmptyPath, deepCopy(raw as JsonValue)]);
				children.delete(key);
				return Reflect.set(at, key, raw);
			},

			deleteProperty(at, key) {
				if (typeof key === "symbol") return Reflect.deleteProperty(at, key);
				if (Object.hasOwn(at, key)) emit(["d", [...path, norm(at, key)] as unknown as NonEmptyPath]);
				return Reflect.deleteProperty(at, key);
			},
		});
		targets.set(proxy, target);
		return proxy;
	};

	const state = wrap(root, []) as T;

	return {
		state,
		get target() {
			return root;
		},
		flush() {
			if (forceBase) {
				// The base batch carries every mutation made before it, snapshot at
				// flush time so later writes cannot reach back into the emitted op.
				const value = deepCopy(root as unknown as JsonValue);
				forceBase = false;
				clearPending();
				return [["r", value]];
			}
			if (!hasPending) return [];
			const out = pending;
			clearPending();
			return out;
		},
		rebase() {
			// Ops recorded before a rebase describe a value the base batch supersedes.
			clearPending();
			forceBase = true;
		},
		discard() {
			clearPending();
		},
		get dirty() {
			// Conservative: true if anything was written since the last flush, even
			// if the writes cancelled out. A consumer has nothing until the first
			// flush, so a base batch is owed and dirty starts true.
			return forceBase || hasPending;
		},
	};
}

// ─── Applier ─────────────────────────────────────────────────────────────────

export class PathError extends Error {
	// Not a parameter property: Node's --experimental-strip-types rejects those,
	// and these files are meant to run under it directly.
	readonly path: Path | number;
	constructor(path: Path | number) {
		super(`unresolvable path: ${JSON.stringify(path)}`);
		this.path = path;
		this.name = "PathError";
	}
}

/**
 * Apply ops to a plain mutable value. Returns the value, because `r` replaces it
 * outright and cannot be done in place.
 */
export function apply<T>(target: T | undefined, ops: readonly Op[]): T {
	return applyOps(target, ops);
}

function applyOps<T>(target: T | undefined, ops: readonly Op[]): T {
	let root = target as unknown as JsonValue;

	for (const op of ops) {
		if (op[0] === "r") {
			// Adopted, not copied. The consumer owns the batch it was handed.
			//
			// Fanning one batch out to several consumers in-process therefore makes
			// their replicas alias each other. That is an ownership rule, not a
			// defect: copy the batch at the fan-out point. A batch that crosses a
			// real boundary is already distinct, because serialisation produces
			// fresh objects.
			root = op[1];
			continue;
		}

		const path = op[1];

		if (op[0] === "p") {
			const target_ = path.length === 0 ? root : resolve(root, path);
			if (!Array.isArray(target_)) throw new PathError(path);
			target_.splice(op[2], op[3]);
			const chunkSize = 10_000;
			for (let offset = 0; offset < op[4].length; offset += chunkSize) {
				target_.splice(op[2] + offset, 0, ...op[4].slice(offset, offset + chunkSize));
			}
			continue;
		}

		// s/d/a/t can never target the root — the type forbids it.
		const parent = resolve(root, path.slice(0, -1)) as Record<Seg, JsonValue>;
		const key = path[path.length - 1]!;
		// defineProperty rather than assignment: a setter inherited from the prototype
		// chain would otherwise run on write.
		const write = (value: JsonValue) => {
			Object.defineProperty(parent, key, { value, writable: true, enumerable: true, configurable: true });
		};
		const read = (): unknown => (Object.hasOwn(parent, key) ? parent[key] : undefined);
		switch (op[0]) {
			case "s":
				write(op[2]);
				break;
			case "d":
				if (Array.isArray(parent)) {
					if (typeof key !== "number" || key >= parent.length) throw new PathError(path);
					(parent as unknown as JsonValue[]).splice(key, 1);
				} else delete parent[key];
				break;
			case "a": {
				const current = read();
				if (typeof current !== "string") throw new PathError(path);
				write(`${current}${op[2]}`);
				break;
			}
			case "t": {
				const current = read();
				if (typeof current !== "string") throw new PathError(path);
				write(current.slice(op[2]));
				break;
			}
		}
	}
	return root as unknown as T;
}

/** Apply operations without mutating the previous immutable value. */
export function applyImmutable<T>(target: T | undefined, ops: readonly Op[]): T {
	let root = target as unknown as JsonValue;
	for (const op of ops) {
		if (op[0] === "r") {
			root = op[1];
			continue;
		}
		root = copyContainers(root, op[0] === "p" ? op[1] : op[1].slice(0, -1));
		root = applyOps(root, [op]);
	}
	return root as unknown as T;
}

/**
 * Fresh-copy every container along `path`, sharing everything else by
 * reference. A container that is not on the path is never copied, which is why
 * unchanged subtrees stay reference-equal to the previous value.
 */
function copyContainers(root: JsonValue, path: Path): JsonValue {
	const copy = (value: JsonValue): JsonValue[] | Record<string, JsonValue> => {
		if (Array.isArray(value)) return value.slice();
		if (!isObj(value)) throw new PathError(path);
		const result = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype) as Record<
			string,
			JsonValue
		>;
		for (const key of Object.keys(value)) {
			Object.defineProperty(result, key, {
				value: (value as Record<string, JsonValue>)[key],
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
		return result;
	};
	const copiedRoot = copy(root);
	let source = root;
	let destination = copiedRoot;
	for (const segment of path) {
		if (!isObj(source) || !Object.hasOwn(source, segment)) throw new PathError(path);
		const child = (source as Record<Seg, JsonValue>)[segment]!;
		const copiedChild = copy(child);
		Object.defineProperty(destination, segment, {
			value: copiedChild,
			writable: true,
			enumerable: true,
			configurable: true,
		});
		source = child;
		destination = copiedChild;
	}
	return copiedRoot;
}

function resolveValue(root: JsonValue, path: Path): JsonValue {
	let node: JsonValue = root;
	for (const seg of path) {
		if (!isObj(node)) throw new PathError(path);
		// Own properties only: an inherited getter must not run, and a walk must not
		// escape the value into the prototype chain.
		if (!Object.hasOwn(node, seg as PropertyKey)) throw new PathError(path);
		node = (node as Record<Seg, JsonValue>)[seg]!;
	}
	return node;
}

function resolve(root: JsonValue, path: Path): JsonValue {
	const node = resolveValue(root, path);
	if (!isObj(node)) throw new PathError(path);
	return node;
}
