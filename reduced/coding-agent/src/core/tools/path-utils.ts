// Reduced from packages/coding-agent/src/core/tools/path-utils.ts.
// Dropped: macOS screenshot/NFD/curly-quote filename-variant fallbacks and the sync twin.

import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolvePath } from "node:path";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizePathInput(input: string): string {
	let normalized = input.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}
	const home = homedir();
	if (normalized === "~") {
		return home;
	}
	if (normalized.startsWith("~/")) {
		return join(home, normalized.slice(2));
	}
	return normalized;
}

/**
 * Resolve a path relative to the given cwd.
 * Handles `~` expansion, a leading `@` prefix, and unicode-space normalization.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	const normalized = normalizePathInput(filePath);
	return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(cwd, normalized);
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}
