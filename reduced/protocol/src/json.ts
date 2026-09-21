// Local stand-ins so the copy is standalone.
// - Context: opaque marker (reduced from @earendil-works/chord; not used here).
// - isJsonValue: strict JSON check (reduced from @earendil-works/chord).

export interface Context {}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export function isJsonValue(value: unknown): value is JsonValue {
	return isJsonDeep(value, new Set());
}

function isJsonDeep(value: unknown, ancestors: Set<object>): boolean {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return value.every((item) => isJsonDeep(item, ancestors));
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
		return Object.keys(value).every((key) => isJsonDeep((value as Record<string, unknown>)[key], ancestors));
	} finally {
		ancestors.delete(value);
	}
}
