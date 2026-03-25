import { stat } from "node:fs/promises";

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

const OPEN_BIN = "/usr/bin/open";
const FORK_CLI_CANDIDATES = ["/usr/local/bin/fork", "/opt/homebrew/bin/fork"] as const;

interface CommandSpec {
	name: string;
	appName: string;
	description: string;
	launcher?: "open" | "fork-cli";
}

interface OpenExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
}

const COMMANDS: CommandSpec[] = [
	{
		name: "my-open-zed",
		appName: "Zed",
		description: "Open Zed at the active piw worktree root when applicable, otherwise the current session directory.",
	},
	{
		name: "my-open-fork",
		appName: "Fork",
		description: "Open Fork at the active piw worktree root when applicable, otherwise the current session directory.",
		launcher: "fork-cli",
	},
];

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
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

function usage(commandName: string): string {
	return `Usage: /${commandName}`;
}

function validateInvocation(commandName: string, args: string, ctx: ExtensionCommandContext): boolean {
	const trimmed = args.trim();
	if (!trimmed) return true;

	if (trimmed === "help" || trimmed === "--help" || trimmed === "-h") {
		notify(ctx, usage(commandName), "info");
		return false;
	}

	throw new Error(`/${commandName} does not accept arguments. ${usage(commandName)}`);
}

async function getPathStats(targetPath: string) {
	try {
		return await stat(targetPath);
	} catch {
		return null;
	}
}

async function assertDirectoryExists(targetPath: string, label: string): Promise<void> {
	const targetStats = await getPathStats(targetPath);
	if (!targetStats) {
		throw new Error(`${label} does not exist: ${targetPath}`);
	}

	if (!targetStats.isDirectory()) {
		throw new Error(`${label} is not a directory: ${targetPath}`);
	}
}

async function resolveTargetDirectory(ctx: ExtensionCommandContext): Promise<string> {
	if (process.env.PI_WORKTREE_SESSION === "1") {
		const worktreePath = process.env.PI_WORKTREE_PATH?.trim();
		if (!worktreePath) {
			throw new Error("This looks like a piw worktree session, but PI_WORKTREE_PATH is missing.");
		}

		await assertDirectoryExists(worktreePath, "The piw worktree path");
		return worktreePath;
	}

	const cwd = ctx.cwd?.trim();
	if (!cwd) {
		throw new Error("The current session directory is unavailable.");
	}

	await assertDirectoryExists(cwd, "The current session directory");
	return cwd;
}

function formatExecFailure(label: string, targetPath: string, result: OpenExecResult): string {
	const stderr = result.stderr.trim();
	const stdout = result.stdout.trim();
	const detail = stderr || stdout || `${label} failed with exit code ${result.code}`;
	return `Failed to open ${label} at ${targetPath}: ${detail}`;
}

async function runCommand(pi: ExtensionAPI, command: string, args: string[], label: string, targetPath: string): Promise<void> {
	let result: OpenExecResult;
	try {
		result = (await pi.exec(command, args)) as OpenExecResult;
	} catch (error) {
		throw new Error(`Failed to launch ${label}: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (result.code !== 0) {
		throw new Error(formatExecFailure(label, targetPath, result));
	}
}

async function resolveForkCliPath(): Promise<string | null> {
	for (const candidate of FORK_CLI_CANDIDATES) {
		const candidateStats = await getPathStats(candidate);
		if (candidateStats?.isFile()) {
			return candidate;
		}
	}

	return null;
}

async function openApp(pi: ExtensionAPI, command: CommandSpec, targetPath: string): Promise<void> {
	if (command.launcher === "fork-cli") {
		const forkCliPath = await resolveForkCliPath();
		if (forkCliPath) {
			await runCommand(pi, forkCliPath, ["-C", targetPath, "open"], command.appName, targetPath);
			return;
		}
	}

	await runCommand(pi, OPEN_BIN, ["-a", command.appName, targetPath], command.appName, targetPath);
}

export default function myOpenLocalApps(pi: ExtensionAPI): void {
	for (const command of COMMANDS) {
		pi.registerCommand(command.name, {
			description: command.description,
			handler: async (args, ctx) => {
				if (!validateInvocation(command.name, args, ctx)) {
					return;
				}

				const targetPath = await resolveTargetDirectory(ctx);
				await openApp(pi, command, targetPath);
				notify(ctx, `Opened ${command.appName} at ${targetPath}.`, "info");
			},
		});
	}
}
