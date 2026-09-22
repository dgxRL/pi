// Reduced from packages/coding-agent/src/core/tools/find.ts. Dropped: FindOperations hook,
// the win32 [/\\] glob rewrite, and the pathModule parameter of relativizeFindResultPath.

import { createInterface } from "node:readline";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { spawn } from "node:child_process";
import type { AgentTool, AgentToolResult } from "../../../../agent/src/index.ts";
import { type Static, Type } from "typebox";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { ensureTool } from "./shell.ts";
import { constrainedSampling, wrapToolDefinition } from "./types.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

/** Relativize a find result against the search root and normalize it to posix separators. */
export function relativizeFindResultPath(resultPath: string, searchPath: string): string {
	const hadTrailingSeparator = resultPath.endsWith(sep);
	const relativePath = isAbsolute(resultPath) ? relative(searchPath, resultPath) : resultPath;
	const posixPath = relativePath.split(sep).join("/");
	return hadTrailingSeparator && !posixPath.endsWith("/") ? `${posixPath}/` : posixPath;
}

const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

export const findToolSystemPromptContribution = {
	snippet: "Find files by glob pattern (respects .gitignore)",
	guidelines: [],
} as const;

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
}

export function createFindTool(cwd: string): AgentTool<typeof findSchema, FindToolDetails | undefined> {
	return wrapToolDefinition<typeof findSchema, FindToolDetails | undefined>({
		name: "find",
		label: "find",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: findToolSystemPromptContribution.snippet,
		parameters: findSchema,
		constrainedSampling,
		async execute(_toolCallId, { pattern, path: searchDir, limit }: FindToolInput, signal?: AbortSignal) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const searchPath = resolveToCwd(searchDir || ".", cwd);
			const effectiveLimit = limit ?? DEFAULT_LIMIT;

			const fdPath = await ensureTool("fd");
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			if (!fdPath) {
				throw new Error("fd is not available");
			}

			const args: string[] = ["--glob", "--color=never", "--hidden"];

			// fd normally ignores .gitignore outside git repos, so keep --no-require-git
			// there. Inside repos, use fd's default git-aware behavior so parent
			// .gitignore rules stop at nested repo boundaries.
			let insideGitRepo = false;
			for (let current = searchPath; ; ) {
				if (await pathExists(join(current, ".git"))) {
					insideGitRepo = true;
					break;
				}
				const parent = dirname(current);
				if (parent === current) break;
				current = parent;
			}
			if (!insideGitRepo) args.push("--no-require-git");
			args.push("--max-results", String(effectiveLimit));

			// fd --glob matches against the basename unless --full-path is set; in --full-path
			// mode it matches against the absolute candidate path, so a path-containing
			// pattern like 'src/**/*.spec.ts' needs a leading '**/' to match anything.
			let effectivePattern = pattern;
			if (pattern.includes("/")) {
				args.push("--full-path");
				if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
					effectivePattern = `**/${pattern}`;
				}
			}
			args.push("--", effectivePattern, searchPath);

			// Streaming child-process events settle the promise from the close handler.
			const { promise, resolve, reject } = Promise.withResolvers<AgentToolResult<FindToolDetails | undefined>>();
			const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
			const rl = createInterface({ input: child.stdout });
			let stderr = "";
			const lines: string[] = [];

			const stopChild = () => {
				if (!child.killed) {
					child.kill();
				}
			};
			const onAbort = () => {
				stopChild();
				reject(new Error("Operation aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			child.stderr?.on("data", (chunk) => {
				stderr += chunk.toString();
			});

			rl.on("line", (line) => {
				lines.push(line);
			});

			child.on("error", (error) => {
				rl.close();
				signal?.removeEventListener("abort", onAbort);
				reject(new Error(`Failed to run fd: ${error.message}`));
			});

			child.on("close", (code) => {
				rl.close();
				signal?.removeEventListener("abort", onAbort);
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				const output = lines.join("\n");
				if (code !== 0) {
					const errorMsg = stderr.trim() || `fd exited with code ${code}`;
					if (!output) {
						reject(new Error(errorMsg));
						return;
					}
				}
				if (!output) {
					resolve({ content: [{ type: "text", text: "No files found matching pattern" }], details: undefined });
					return;
				}

				const relativized: string[] = [];
				for (const rawLine of lines) {
					const line = rawLine.replace(/\r$/, "").trim();
					if (!line) continue;
					relativized.push(relativizeFindResultPath(line, searchPath));
				}

				const resultLimitReached = relativized.length >= effectiveLimit;
				const rawOutput = relativized.join("\n");
				const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
				let resultOutput = truncation.content;
				const details: FindToolDetails = {};
				const notices: string[] = [];
				if (resultLimitReached) {
					notices.push(
						`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
					);
					details.resultLimitReached = effectiveLimit;
				}
				if (truncation.truncated) {
					notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
					details.truncation = truncation;
				}
				if (notices.length > 0) {
					resultOutput += `\n\n[${notices.join(". ")}]`;
				}
				resolve({
					content: [{ type: "text", text: resultOutput }],
					details: Object.keys(details).length > 0 ? details : undefined,
				});
			});

			return promise;
		},
	});
}
