import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

const COMMAND_NAME = "my-worktree-pill";
const STATUS_KEY = "piw_worktree";
const STATUS_ICON = "sparkle";
const STATUS_COLOR = "#7c3aed";
const COMMAND_USAGE = `Usage: /${COMMAND_NAME} [clear | set [text]]`;

interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
}

type CommandAction =
	| { kind: "sync" }
	| { kind: "clear" }
	| { kind: "set"; text: string | null };

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

function getTrimmedEnv(name: string): string | null {
	const value = process.env[name];
	if (typeof value !== "string") {
		return null;
	}

	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function getDefaultPillText(): string | null {
	if (process.env.PI_WORKTREE_SESSION !== "1") {
		return null;
	}

	return getTrimmedEnv("PI_WORKTREE_NAME");
}

function parseAction(args: string, ctx: ExtensionCommandContext): CommandAction | null {
	const trimmed = args.trim();
	if (!trimmed) {
		return { kind: "sync" };
	}

	if (trimmed === "help" || trimmed === "--help" || trimmed === "-h") {
		notify(ctx, COMMAND_USAGE, "info");
		return null;
	}

	if (trimmed === "clear") {
		return { kind: "clear" };
	}

	if (trimmed === "set") {
		return { kind: "set", text: null };
	}

	if (trimmed.startsWith("set ")) {
		const text = trimmed.slice("set ".length).trim();
		if (!text) {
			throw new Error(`/${COMMAND_NAME} set requires text or an active piw worktree session. ${COMMAND_USAGE}`);
		}
		return { kind: "set", text };
	}

	throw new Error(`Invalid arguments for /${COMMAND_NAME}. ${COMMAND_USAGE}`);
}

async function runCmux(pi: ExtensionAPI, args: string[], action: string): Promise<ExecResult> {
	try {
		return (await pi.exec("cmux", args)) as ExecResult;
	} catch (error) {
		throw new Error(`${action} failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function formatExecFailure(action: string, result: ExecResult): string {
	const stderr = result.stderr.trim();
	const stdout = result.stdout.trim();
	const detail = stderr || stdout || `${action} failed with exit code ${result.code}`;
	return `${action} failed: ${detail}`;
}

async function isCmuxAvailable(pi: ExtensionAPI): Promise<boolean> {
	const workspaceId = getTrimmedEnv("CMUX_WORKSPACE_ID");
	if (!workspaceId) {
		return false;
	}

	try {
		const result = (await pi.exec("cmux", ["ping"])) as ExecResult;
		return result.code === 0;
	} catch {
		return false;
	}
}

async function setPill(pi: ExtensionAPI, text: string): Promise<void> {
	const result = await runCmux(
		pi,
		["set-status", STATUS_KEY, text, "--icon", STATUS_ICON, "--color", STATUS_COLOR],
		"Setting cmux worktree pill",
	);
	if (result.code !== 0) {
		throw new Error(formatExecFailure("Setting cmux worktree pill", result));
	}
}

async function clearPill(pi: ExtensionAPI): Promise<void> {
	const result = await runCmux(pi, ["clear-status", STATUS_KEY], "Clearing cmux worktree pill");
	if (result.code !== 0) {
		throw new Error(formatExecFailure("Clearing cmux worktree pill", result));
	}
}

function resolveSetText(action: Extract<CommandAction, { kind: "set" }>): string {
	if (action.text) {
		return action.text;
	}

	const worktreeName = getDefaultPillText();
	if (worktreeName) {
		return worktreeName;
	}

	throw new Error(`/${COMMAND_NAME} set requires text unless this is an active piw worktree session. ${COMMAND_USAGE}`);
}

export default function myWorktreePill(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Manually set or clear a cmux sidebar status pill for the active workspace.",
		handler: async (args, ctx) => {
			const action = parseAction(args, ctx);
			if (!action) {
				return;
			}

			const cmuxAvailable = await isCmuxAvailable(pi);
			if (!cmuxAvailable) {
				return;
			}

			if (action.kind === "clear") {
				await clearPill(pi);
				notify(ctx, "Cleared the cmux worktree pill.", "info");
				return;
			}

			if (action.kind === "set") {
				const text = resolveSetText(action);
				await setPill(pi, text);
				notify(ctx, `Set the cmux worktree pill to ${text}.`, "info");
				return;
			}

			const text = getDefaultPillText();
			if (text) {
				await setPill(pi, text);
				notify(ctx, `Set the cmux worktree pill to ${text}.`, "info");
				return;
			}

			await clearPill(pi);
			notify(ctx, "Cleared the cmux worktree pill.", "info");
		},
	});
}
