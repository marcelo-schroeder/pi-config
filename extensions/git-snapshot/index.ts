import { resolve } from "node:path";

import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { isSnapshotToolAuthorizedForEntries, type SnapshotAuthorizationEntry } from "./authorization.js";
import {
	createSnapshot,
	resolveRepoRoot,
	SNAPSHOT_MESSAGE_PREFIX,
	type CreateSnapshotResult,
} from "./snapshot.js";

type SnapshotSubcommand = "create" | "list" | "restore" | "help";

interface ParsedSnapshotCommand {
	subcommand: SnapshotSubcommand;
	args: string[];
}

interface CreateOptions {
	message?: string;
	trackedOnly: boolean;
}

interface ListOptions {
	limit: number;
}

interface RestoreOptions {
	snapshot?: string;
	restoreIndex: boolean;
	yes: boolean;
}

interface SnapshotListEntry {
	stashRef: string;
	commit: string;
	message: string;
}

const SnapshotCreateToolParams = Type.Object({
	repoPath: Type.Optional(
		Type.String({
			description: "Path to the target Git repository. Defaults to the current session working directory.",
		}),
	),
	message: Type.Optional(
		Type.String({
			description: "Optional snapshot message. If omitted, a timestamped pi snapshot message is generated.",
		}),
	),
	trackedOnly: Type.Optional(
		Type.Boolean({
			description: "When true, exclude untracked files from the snapshot.",
		}),
	),
});

const SNAPSHOT_SUBCOMMANDS = new Set<SnapshotSubcommand | "--help" | "-h">([
	"create",
	"list",
	"restore",
	"help",
	"--help",
	"-h",
]);

const SNAPSHOT_TOOL_NAME = "git_snapshot_create";
const SNAPSHOT_SKILL_NAME = "my-commit-changes";
const SNAPSHOT_STASH_FORMAT = "%gd%x09%H%x09%gs";
const DEFAULT_LIST_LIMIT = 10;

const SNAPSHOT_TOOL_BLOCK_REASON = [
	`${SNAPSHOT_TOOL_NAME} is reserved for explicit /skill:${SNAPSHOT_SKILL_NAME} runs.`,
	"For manual snapshots, use /snapshot create instead.",
].join(" ");

const SNAPSHOT_HELP_TEXT = [
	"Git Snapshot",
	"",
	"Usage:",
	"  /snapshot create [--message \"...\"] [--tracked-only]",
	"  /snapshot list [--limit N]",
	"  /snapshot restore [<snapshot>] [--no-index] [--yes]",
	"",
	"Defaults:",
	"  create   includes untracked files by default",
	`  list     shows only snapshots with prefix: ${SNAPSHOT_MESSAGE_PREFIX}`,
	"  restore  uses --index by default and confirms on dirty repos",
	"",
	"Subcommands:",
	"  create   Create a snapshot without modifying the worktree or index",
	"  list     List snapshots created by this extension",
	"  restore  Restore a previously created snapshot",
].join("\n");

function isSnapshotToolAuthorized(ctx: ExtensionContext): boolean {
	return isSnapshotToolAuthorizedForEntries(ctx.sessionManager.getBranch() as SnapshotAuthorizationEntry[]);
}

function tokenizeArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaping = false;

	for (const char of input.trim()) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}

		if (char === "\\") {
			escaping = true;
			continue;
		}

		if (quote) {
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}

		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}

		if (/\s/.test(char)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (escaping) {
		current += "\\";
	}

	if (quote) {
		throw new Error(`Unterminated ${quote} quote in /snapshot arguments.`);
	}

	if (current.length > 0) {
		tokens.push(current);
	}

	return tokens;
}

function parseSnapshotCommand(rawArgs: string): ParsedSnapshotCommand {
	const tokens = tokenizeArgs(rawArgs);
	if (tokens.length === 0) {
		return { subcommand: "help", args: [] };
	}

	const [first, ...rest] = tokens;
	if (!SNAPSHOT_SUBCOMMANDS.has(first as SnapshotSubcommand | "--help" | "-h")) {
		throw new Error(`Unknown /snapshot subcommand: ${first}`);
	}

	if (first === "help" || first === "--help" || first === "-h") {
		return { subcommand: "help", args: rest };
	}

	return { subcommand: first, args: rest } as ParsedSnapshotCommand;
}

function parseCreateArgs(args: string[]): CreateOptions {
	const options: CreateOptions = { trackedOnly: false };

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "--tracked-only":
				options.trackedOnly = true;
				break;
			case "--message":
			case "-m": {
				const value = args[i + 1];
				if (!value) {
					throw new Error(`Missing value for ${arg}`);
				}
				options.message = value;
				i += 1;
				break;
			}
			default:
				throw new Error(`Unknown /snapshot create argument: ${arg}`);
		}
	}

	return options;
}

function parseListArgs(args: string[]): ListOptions {
	const options: ListOptions = { limit: DEFAULT_LIST_LIMIT };

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "--limit": {
				const value = args[i + 1];
				if (!value) {
					throw new Error("Missing value for --limit");
				}
				const parsed = Number.parseInt(value, 10);
				if (!Number.isInteger(parsed) || parsed <= 0) {
					throw new Error(`Invalid --limit value: ${value}`);
				}
				options.limit = parsed;
				i += 1;
				break;
			}
			default:
				throw new Error(`Unknown /snapshot list argument: ${arg}`);
		}
	}

	return options;
}

function parseRestoreArgs(args: string[]): RestoreOptions {
	const options: RestoreOptions = { restoreIndex: true, yes: false };

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "--no-index":
				options.restoreIndex = false;
				break;
			case "--yes":
				options.yes = true;
				break;
			default:
				if (arg.startsWith("-")) {
					throw new Error(`Unknown /snapshot restore argument: ${arg}`);
				}
				if (options.snapshot) {
					throw new Error(`Unexpected extra restore target: ${arg}`);
				}
				options.snapshot = arg;
		}
	}

	return options;
}

function notifyOrLog(
	ctx: ExtensionCommandContext,
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}

	const output = `${level.toUpperCase()}: ${message}`;
	if (level === "error") {
		console.error(output);
	} else {
		console.log(output);
	}
}

function showHelp(ctx: ExtensionCommandContext, prefix?: string): void {
	const message = prefix ? `${prefix}\n\n${SNAPSHOT_HELP_TEXT}` : SNAPSHOT_HELP_TEXT;
	notifyOrLog(ctx, message, prefix ? "warning" : "info");
}

function summarizeCreateResult(result: CreateSnapshotResult): string {
	if (!result.created) {
		return result.reason ? `No snapshot created: ${result.reason}` : "No snapshot created.";
	}

	const shortCommit = result.snapshotCommit?.slice(0, 7) ?? "unknown";
	const stashRef = result.stashRef ?? "(unknown stash ref)";
	const untracked = result.includedUntracked ? "yes" : "no";
	return `Created snapshot ${stashRef} (${shortCommit}), untracked: ${untracked}`;
}

function parseSnapshotList(stdout: string): SnapshotListEntry[] {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [stashRef, commit, message] = line.split("\t");
			if (!stashRef || !commit || !message) {
				return null;
			}
			return { stashRef, commit, message } satisfies SnapshotListEntry;
		})
		.filter((entry): entry is SnapshotListEntry => entry !== null)
		.filter((entry) => entry.message.includes(SNAPSHOT_MESSAGE_PREFIX));
}

function formatSnapshotListEntry(entry: SnapshotListEntry): string {
	return `${entry.stashRef}  ${entry.commit.slice(0, 7)}  ${entry.message}`;
}

function normalizePathArgument(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function resolveToolRepoPath(cwd: string, repoPath?: string): string {
	if (!repoPath) {
		return cwd;
	}
	return resolve(cwd, normalizePathArgument(repoPath));
}

async function listSnapshots(pi: ExtensionAPI, repoRoot: string): Promise<SnapshotListEntry[]> {
	const result = await pi.exec("git", ["-C", repoRoot, "stash", "list", `--format=${SNAPSHOT_STASH_FORMAT}`]);
	if (result.code !== 0) {
		const stderr = result.stderr.trim() || result.stdout.trim() || "Failed to read git stash list.";
		throw new Error(stderr);
	}
	return parseSnapshotList(result.stdout);
}

async function getDirtyRepoSummary(pi: ExtensionAPI, repoRoot: string): Promise<string[]> {
	const result = await pi.exec("git", ["-C", repoRoot, "status", "--porcelain"]);
	if (result.code !== 0) {
		const stderr = result.stderr.trim() || result.stdout.trim() || "Failed to inspect git status.";
		throw new Error(stderr);
	}
	return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function findSnapshotByRef(snapshots: SnapshotListEntry[], target: string): SnapshotListEntry | undefined {
	return snapshots.find((entry) => entry.stashRef === target || entry.commit === target || entry.commit.startsWith(target));
}

async function chooseSnapshot(
	ctx: ExtensionCommandContext,
	snapshots: SnapshotListEntry[],
): Promise<SnapshotListEntry | undefined> {
	if (snapshots.length === 0) return undefined;
	if (!ctx.hasUI) return undefined;

	const items = snapshots.map(formatSnapshotListEntry);
	const selected = await ctx.ui.select("Git Snapshots", items);
	if (!selected) return undefined;
	return snapshots.find((entry) => formatSnapshotListEntry(entry) === selected);
}

async function handleCreate(args: string[], ctx: ExtensionCommandContext): Promise<void> {
	await ctx.waitForIdle();
	const options = parseCreateArgs(args);
	const result = await createSnapshot({
		repoPath: ctx.cwd,
		message: options.message,
		trackedOnly: options.trackedOnly,
	});
	notifyOrLog(ctx, summarizeCreateResult(result), result.created ? "info" : "warning");
}

async function handleList(pi: ExtensionAPI, args: string[], ctx: ExtensionCommandContext): Promise<void> {
	await ctx.waitForIdle();
	const options = parseListArgs(args);
	const repoRoot = await resolveRepoRoot(ctx.cwd);
	const snapshots = await listSnapshots(pi, repoRoot);
	const limited = snapshots.slice(0, options.limit);

	if (limited.length === 0) {
		notifyOrLog(ctx, `No snapshots found with prefix ${SNAPSHOT_MESSAGE_PREFIX}`, "info");
		return;
	}

	if (ctx.hasUI) {
		const items = limited.map(formatSnapshotListEntry);
		const selected = await ctx.ui.select("Git Snapshots", items);
		if (selected) {
			ctx.ui.notify(selected, "info");
		}
		return;
	}

	console.log(limited.map(formatSnapshotListEntry).join("\n"));
}

async function handleRestore(pi: ExtensionAPI, args: string[], ctx: ExtensionCommandContext): Promise<void> {
	await ctx.waitForIdle();
	const options = parseRestoreArgs(args);
	const repoRoot = await resolveRepoRoot(ctx.cwd);
	const snapshots = await listSnapshots(pi, repoRoot);
	if (snapshots.length === 0) {
		notifyOrLog(ctx, `No snapshots found with prefix ${SNAPSHOT_MESSAGE_PREFIX}`, "warning");
		return;
	}

	let snapshot: SnapshotListEntry | undefined;
	if (options.snapshot) {
		snapshot = findSnapshotByRef(snapshots, options.snapshot);
		if (!snapshot) {
			throw new Error(`Snapshot not found: ${options.snapshot}`);
		}
	} else {
		snapshot = await chooseSnapshot(ctx, snapshots);
		if (!snapshot) {
			if (ctx.hasUI) {
				notifyOrLog(ctx, "Snapshot restore cancelled.", "warning");
				return;
			}
			throw new Error("Non-interactive restore requires an explicit snapshot ref or commit.");
		}
	}

	const dirtyEntries = await getDirtyRepoSummary(pi, repoRoot);
	if (dirtyEntries.length > 0 && !options.yes) {
		if (!ctx.hasUI) {
			throw new Error("Refusing to restore onto a dirty repo without --yes in non-interactive mode.");
		}
		const preview = dirtyEntries.slice(0, 5).join("\n");
		const suffix = dirtyEntries.length > 5 ? `\n… and ${dirtyEntries.length - 5} more` : "";
		const ok = await ctx.ui.confirm(
			"Restore snapshot?",
			`Restore ${snapshot.stashRef} (${snapshot.commit.slice(0, 7)}) onto the current dirty workspace?\n\n${preview}${suffix}`,
		);
		if (!ok) {
			notifyOrLog(ctx, "Snapshot restore cancelled.", "warning");
			return;
		}
	}

	const gitArgs = ["-C", repoRoot, "stash", "apply"];
	if (options.restoreIndex) {
		gitArgs.push("--index");
	}
	gitArgs.push(snapshot.commit);

	const result = await pi.exec("git", gitArgs);
	if (result.code !== 0) {
		const stderr = result.stderr.trim() || result.stdout.trim() || "Snapshot restore failed.";
		throw new Error(stderr);
	}

	notifyOrLog(
		ctx,
		`Restored snapshot ${snapshot.stashRef} (${snapshot.commit.slice(0, 7)})${options.restoreIndex ? " with index" : ""}`,
		"info",
	);
}

export default function gitSnapshotExtension(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== SNAPSHOT_TOOL_NAME) {
			return;
		}

		if (isSnapshotToolAuthorized(ctx)) {
			return;
		}

		return {
			block: true,
			reason: SNAPSHOT_TOOL_BLOCK_REASON,
		};
	});

	pi.registerTool({
		name: SNAPSHOT_TOOL_NAME,
		label: "Git Snapshot Create",
		description: `Reserved snapshot tool for explicit /skill:${SNAPSHOT_SKILL_NAME} workflows. Use /snapshot create for direct snapshot requests.`,
		parameters: SnapshotCreateToolParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await createSnapshot({
				repoPath: resolveToolRepoPath(ctx.cwd, params.repoPath),
				message: params.message,
				trackedOnly: params.trackedOnly,
				signal,
			});

			return {
				content: [{ type: "text", text: summarizeCreateResult(result) }],
				details: result,
			};
		},
	});

	pi.registerCommand("snapshot", {
		description: "Create, list, and restore git workspace snapshots via slash command",
		getArgumentCompletions: (prefix) => {
			const tokens = tokenizeArgs(prefix);
			if (prefix.endsWith(" ")) {
				tokens.push("");
			}

			if (tokens.length <= 1) {
				const choices = ["create", "list", "restore", "help"];
				return choices.filter((choice) => choice.startsWith(tokens[0] ?? "")).map((choice) => ({ value: choice, label: choice }));
			}

			const [subcommand, ...rest] = tokens;
			if (subcommand === "create") {
				const choices = ["--message", "--tracked-only"];
				const current = rest.at(-1) ?? "";
				return choices.filter((choice) => choice.startsWith(current)).map((choice) => ({ value: choice, label: choice }));
			}

			if (subcommand === "list") {
				const choices = ["--limit"];
				const current = rest.at(-1) ?? "";
				return choices.filter((choice) => choice.startsWith(current)).map((choice) => ({ value: choice, label: choice }));
			}

			if (subcommand === "restore") {
				const choices = ["--no-index", "--yes"];
				const current = rest.at(-1) ?? "";
				return choices.filter((choice) => choice.startsWith(current)).map((choice) => ({ value: choice, label: choice }));
			}

			return null;
		},
		handler: async (args, ctx) => {
			try {
				const parsed = parseSnapshotCommand(args);

				switch (parsed.subcommand) {
					case "create":
						await handleCreate(parsed.args, ctx);
						return;
					case "list":
						await handleList(pi, parsed.args, ctx);
						return;
					case "restore":
						await handleRestore(pi, parsed.args, ctx);
						return;
					case "help":
					default:
						showHelp(ctx);
						return;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				showHelp(ctx, message);
			}
		},
	});
}
