// Reduced from packages/agent/src/harness/session/fork.ts + fork-policy.ts.
// A fork copies a source session's entries and scalar values into a fresh destination session.

import type { Entry, ForkOptions } from "./types.ts";
import { branchTip, type StoredValue, value } from "./values.ts";

export interface ForkSourceSnapshot {
	entries: Entry[];
	scalarValues: StoredValue<unknown>[];
}

export interface ForkDestinationSnapshot {
	/** Destination entries sorted by `seq` ascending. */
	entries: Entry[];
	scalarValues: StoredValue<unknown>[];
	nextSeq: number;
}

interface ProjectedValue {
	namespace: string;
	key: string;
	value: unknown;
}

/** Selects the entries to copy for a branch fork: `requested` up to the branch tip, inclusive. */
function selectBranchEntries(
	sourceEntries: Entry[],
	sourceTips: StoredValue<unknown>[],
	options: Extract<ForkOptions, { scope: "branch" }>,
): { entryIds: Set<string>; destinationTip: string | null } {
	const sourceTip = sourceTips.find(
		(stored) => stored.address.namespace === branchTip("").namespace && stored.address.key === options.branch,
	);
	if (sourceTip === undefined) throw new Error(`Unknown source branch: ${options.branch}`);
	const tip = sourceTip.value as string | null;
	const requested = options.entryId ?? tip;
	const entryById = new Map(sourceEntries.map((entry) => [entry.id, entry]));
	let found = requested === null;
	const destinationTip = requested;
	const entryIds = new Set<string>();
	let entryId = tip;
	while (entryId !== null) {
		const parentId = entryById.get(entryId)?.parentId ?? null;
		if (entryId === requested) {
			found = true;
			entryIds.add(entryId);
		} else if (found) {
			entryIds.add(entryId);
		}
		if (parentId === null) break;
		entryId = parentId;
	}
	if (!found) {
		throw new Error(`Fork entry ${requested} is not on source branch ${JSON.stringify(options.branch)}`);
	}
	return { entryIds, destinationTip };
}

/** Projects one source scalar row into destination state; `undefined` drops the row. */
function projectScalarValue(
	stored: StoredValue<unknown>,
	options: ForkOptions,
	destinationTip: string | null,
	isEntryCopied: (entryId: string) => boolean,
): ProjectedValue | undefined {
	const address = { namespace: stored.address.namespace, key: stored.address.key };
	switch (stored.address.namespace) {
		case "pi.session.name":
			return { ...address, value: stored.value };
		case "pi.entry.label":
			return isEntryCopied(stored.address.key) ? { ...address, value: stored.value } : undefined;
		case "pi.branch.tip":
			if (options.scope === "tree") return { ...address, value: stored.value };
			return stored.address.key === options.branch ? { ...address, value: destinationTip } : undefined;
		default:
			return options.scope === "tree" ? { ...address, value: stored.value } : undefined;
	}
}

/** Build the complete logical state for a forked destination session. */
export function createForkSnapshot(source: ForkSourceSnapshot, options: ForkOptions): ForkDestinationSnapshot {
	const sourceTips = source.scalarValues.filter((stored) => stored.address.namespace === branchTip("").namespace);

	let entryIds: Set<string>;
	let destinationTip: string | null = null;
	if (options.scope === "tree") {
		entryIds = new Set(source.entries.map((entry) => entry.id));
	} else {
		const selection = selectBranchEntries(source.entries, sourceTips, options);
		entryIds = selection.entryIds;
		destinationTip = selection.destinationTip;
	}

	const entryById = new Map(source.entries.map((entry) => [entry.id, entry]));
	const entries = [...entryIds]
		.map((id) => entryById.get(id)!)
		.sort((left, right) => left.seq - right.seq);
	const copiedEntryIds = new Set(entries.map((entry) => entry.id));

	let nextSeq = Math.max(0, ...entries.map((entry) => entry.seq)) + 1;
	const scalarValues: StoredValue<unknown>[] = [];
	for (const stored of source.scalarValues) {
		const projected = projectScalarValue(stored, options, destinationTip, (entryId) => copiedEntryIds.has(entryId));
		if (projected === undefined) continue;
		scalarValues.push({
			address: value<unknown>(projected.namespace, projected.key),
			value: projected.value,
			seq: nextSeq++,
		});
	}

	return { entries, scalarValues, nextSeq };
}
