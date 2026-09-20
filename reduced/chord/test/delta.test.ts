// Ported from packages/chord/test/delta.test.ts, pruned for the reduced copy:
// apply/applyImmutable semantics are pinned from the original suite; the
// tracker tests cover the simplified record-per-write contract (the original
// coalescing tracker's exact-op-shape tests are dropped).

import { describe, expect, it } from "vitest";
import { apply, applyImmutable, isBase, isReplace, PathError, track, type Op } from "../src/delta.ts";

describe("tracker", () => {
	it("flushes a base batch first, then deltas a replica can apply", () => {
		const t = track({ user: { name: "ada", tags: ["x"] }, n: 1 });
		t.state.n = 2; // made before the first flush
		const base = t.flush();
		expect(isBase(base)).toBe(true);
		expect(base).toEqual([["r", { user: { name: "ada", tags: ["x"] }, n: 2 }]]);

		t.state.user.name = "grace";
		t.state.user.tags[1] = "y";
		const ops = t.flush();
		// No coalescing: one op per write, in write order.
		expect(ops).toEqual([
			["s", ["user", "name"], "grace"],
			["s", ["user", "tags", 1], "y"],
		]);

		let replica = apply<{ user: { name: string; tags: string[] }; n: number }>(undefined, base);
		replica = apply(replica, ops);
		expect(replica).toEqual(t.target);
		expect(t.target).not.toBe(t.state); // target is the raw value, state the proxy

		t.rebase();
		const checkpoint = t.flush();
		expect(checkpoint).toEqual([["r", { user: { name: "grace", tags: ["x", "y"] }, n: 2 }]]);
		expect(t.flush()).toEqual([]); // rebase applies once, not to every later flush
	});

	it("flushes nothing when nothing changed; dirty flips; discard keeps changes local", () => {
		const t = track({ x: 0 });
		expect(t.flush()).toEqual([["r", { x: 0 }]]);
		expect(t.dirty).toBe(false);
		expect(t.flush()).toEqual([]);

		t.state.x = 1;
		expect(t.dirty).toBe(true);
		expect(t.flush()).toEqual([["s", ["x"], 1]]);
		expect(t.dirty).toBe(false);

		t.state.x = 2;
		t.discard();
		expect(t.dirty).toBe(false);
		expect(t.flush()).toEqual([]);
	});

	it("accumulates across sequential flushes", () => {
		const t = track({ count: 0, label: "" });
		const replica = apply<{ count: number; label: string }>(undefined, t.flush());

		t.state.count = 1;
		const first = t.flush();
		expect(first).toEqual([["s", ["count"], 1]]);

		t.state.label = "ready";
		t.state.count = 2;
		const second = t.flush();
		expect(second).toEqual([
			["s", ["label"], "ready"],
			["s", ["count"], 2],
		]);

		apply(apply(replica, first), second);
		expect(replica).toEqual(t.target);
	});
});

describe("apply", () => {
	it("sets a nested path, including one past an array end", () => {
		expect(apply({ user: { name: "ada" } }, [["s", ["user", "name"], "grace"]])).toEqual({
			user: { name: "grace" },
		});
		expect(apply({ xs: [1, 2, 3] }, [["s", ["xs", 1], 9]])).toEqual({ xs: [1, 9, 3] });
		// An index may address an existing element or append exactly one past the end.
		expect(apply({ xs: [1, 2, 3] }, [["s", ["xs", 3], 9]])).toEqual({ xs: [1, 2, 3, 9] });
	});

	it("deletes a nested path and splices array elements", () => {
		expect(apply({ user: { name: "ada", age: 1 } }, [["d", ["user", "age"]]])).toEqual({ user: { name: "ada" } });
		expect(apply({ xs: [1, 2, 3] }, [["d", ["xs", 1]]])).toEqual({ xs: [1, 3] });
		expect(() => apply({ xs: [1] }, [["d", ["xs", 1]]])).toThrow(PathError);
	});

	it("appends to and truncates strings", () => {
		expect(apply({ s: "hello" }, [["a", ["s"], " world"]])).toEqual({ s: "hello world" });
		// `t` removes `count` characters from the front.
		expect(apply({ s: "abcdef" }, [["t", ["s"], 2]])).toEqual({ s: "cdef" });
		expect(() => apply({ a: 1 }, [["a", ["a"], "x"]])).toThrow(PathError);
		expect(() => apply({ a: "abc" }, [["t", ["missing"], 1]])).toThrow(PathError);
	});

	it("splices arrays: insert, delete, replace, clamp, root", () => {
		expect(apply({ xs: [1, 2] }, [["p", ["xs"], 1, 0, [9]]])).toEqual({ xs: [1, 9, 2] });
		expect(apply({ xs: [1, 2, 3] }, [["p", ["xs"], 0, 1, []]])).toEqual({ xs: [2, 3] });
		expect(apply({ xs: [1, 2, 3] }, [["p", ["xs"], 1, 1, [9]]])).toEqual({ xs: [1, 9, 3] });
		// Remove count past the end clamps, as Array.prototype.splice does.
		expect(apply({ xs: [1, 2] }, [["p", ["xs"], 0, 1e9, []]])).toEqual({ xs: [] });
		expect(apply([1, 2, 3], [["p", [], 3, 0, [4]]])).toEqual([1, 2, 3, 4]);
	});

	it("replaces the whole value on a base op", () => {
		const ops: Op[] = [["r", { fresh: true }]];
		expect(isBase(ops)).toBe(true);
		expect(isReplace(ops[0]!)).toBe(true);
		expect(apply({ old: 1 }, ops)).toEqual({ fresh: true });
		expect(apply<Record<string, unknown>>(undefined, ops)).toEqual({ fresh: true });
	});

	it("throws PathError for a missing parent path", () => {
		expect(() => apply({ a: 1 }, [["s", ["missing", "x"], 1]])).toThrow(PathError);
		expect(() => apply(undefined, [["s", ["a"], 1]])).toThrow(PathError);
	});
});

describe("applyImmutable", () => {
	it("copies changed paths and shares unchanged subtrees", () => {
		const input = { keep: { n: 1 }, list: [1, 2], s: "a" };
		const result = applyImmutable(input, [
			["s", ["s"], "b"],
			["s", ["list", 1], 9],
		]);
		expect(result.s).toBe("b");
		expect(result.keep).toBe(input.keep); // off-path subtree: structurally shared
		expect(result.list).not.toBe(input.list); // on-path container: fresh copy
		expect(result.list).toEqual([1, 9]);
		expect(input).toEqual({ keep: { n: 1 }, list: [1, 2], s: "a" }); // input untouched
	});

	it("does not mutate a replacement payload targeted by a later operation", () => {
		const replacement = { nested: { value: 1 } };
		const next = applyImmutable<{ nested: { value: number } }>(undefined, [
			["r", replacement],
			["s", ["nested", "value"], 2],
		]);
		expect(replacement.nested.value).toBe(1);
		expect(next.nested.value).toBe(2);
	});
});
