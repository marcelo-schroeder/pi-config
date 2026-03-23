import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

import { installReadOnlyFooter } from "./footer.ts";
import { isSafeCommand } from "./safety.ts";

const READ_ONLY_CONTEXT_TYPE = "read-only-context";
const READ_ONLY_STATE_TYPE = "read-only-state";
const RESTRICTED_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", "worktree_info"] as const;
const OPTIONAL_RESTRICTED_TOOLS = ["web_fetch"] as const;

interface PersistedReadOnlyState {
	enabled?: boolean;
	restoreTools?: string[] | null;
}

interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: PersistedReadOnlyState;
}

export default function readOnlyExtension(pi: ExtensionAPI): void {
	let currentCtx: ExtensionContext | undefined;
	let readOnlyEnabled = false;
	let restoreTools: string[] | null = null;

	function getAvailableToolNames(): Set<string> {
		return new Set(pi.getAllTools().map((tool) => tool.name));
	}

	function sanitizeToolNames(names: string[] | null | undefined): string[] {
		if (!names || names.length === 0) return [];
		const available = getAvailableToolNames();
		return [...new Set(names.filter((name) => available.has(name)))];
	}

	function getCurrentActiveTools(): string[] {
		return [...new Set(pi.getActiveTools())];
	}

	function getRestrictedModeTools(): string[] {
		const available = getAvailableToolNames();
		const required = RESTRICTED_TOOLS.filter((name) => available.has(name));
		const optional = OPTIONAL_RESTRICTED_TOOLS.filter((name) => available.has(name));
		return [...required, ...optional];
	}

	function notify(ctx: ExtensionContext | undefined, message: string): void {
		if (ctx?.hasUI) {
			ctx.ui.notify(message, "info");
		}
	}

	function requestToggleReadOnly(ctx: ExtensionContext): void {
		currentCtx = ctx;
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait until the agent is idle before toggling read-only mode.", "warning");
			return;
		}
		applyReadOnlyMode(!readOnlyEnabled, ctx);
	}

	function installUI(ctx?: ExtensionContext): void {
		const activeCtx = ctx ?? currentCtx;
		if (!activeCtx?.hasUI) return;
		activeCtx.ui.setEditorComponent(undefined);
		installReadOnlyFooter(pi, activeCtx, readOnlyEnabled);
	}

	function persistState(): void {
		pi.appendEntry(READ_ONLY_STATE_TYPE, {
			enabled: readOnlyEnabled,
			restoreTools: sanitizeToolNames(restoreTools),
		});
	}

	function applyReadOnlyMode(enabled: boolean, ctx?: ExtensionContext, options?: { silent?: boolean }): void {
		const activeCtx = ctx ?? currentCtx;
		if (!activeCtx) return;
		if (enabled === readOnlyEnabled) {
			installUI(activeCtx);
			return;
		}

		if (enabled) {
			const activeTools = sanitizeToolNames(getCurrentActiveTools());
			if (activeTools.length > 0) {
				restoreTools = activeTools;
			}
			readOnlyEnabled = true;
			pi.setActiveTools(getRestrictedModeTools());
		} else {
			const toolsToRestore = sanitizeToolNames(restoreTools);
			if (toolsToRestore.length > 0) {
				pi.setActiveTools(toolsToRestore);
			}
			readOnlyEnabled = false;
			restoreTools = toolsToRestore.length > 0 ? toolsToRestore : sanitizeToolNames(getCurrentActiveTools());
		}

		persistState();
		installUI(activeCtx);
		if (!options?.silent) {
			notify(activeCtx, `Read-only mode: ${readOnlyEnabled ? "on" : "off"}`);
		}
	}

	function syncStateFromSession(ctx: ExtensionContext): void {
		currentCtx = ctx;
		const previousRestoreTools = sanitizeToolNames(restoreTools);
		const entries = ctx.sessionManager.getBranch() as SessionEntryLike[];
		const persisted = entries
			.filter((entry) => entry.type === "custom" && entry.customType === READ_ONLY_STATE_TYPE)
			.pop()?.data;

		readOnlyEnabled = persisted?.enabled === true;
		restoreTools = sanitizeToolNames(persisted?.restoreTools ?? null);

		if ((!restoreTools || restoreTools.length === 0) && readOnlyEnabled) {
			restoreTools = previousRestoreTools.length > 0 ? previousRestoreTools : sanitizeToolNames(getCurrentActiveTools());
		}

		if (readOnlyEnabled) {
			pi.setActiveTools(getRestrictedModeTools());
		} else {
			const toolsToRestore =
				sanitizeToolNames(restoreTools).length > 0 ? sanitizeToolNames(restoreTools) : previousRestoreTools;
			if (toolsToRestore.length > 0) {
				pi.setActiveTools(toolsToRestore);
			}
			restoreTools = toolsToRestore.length > 0 ? toolsToRestore : null;
		}

		installUI(ctx);
	}

	pi.registerCommand("readonly", {
		description: "Toggle read-only mode.",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			applyReadOnlyMode(!readOnlyEnabled, ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("r"), {
		description: "Toggle read-only mode",
		handler: async (ctx) => {
			requestToggleReadOnly(ctx);
		},
	});

	pi.on("tool_call", async (event) => {
		if (!readOnlyEnabled) return;

		const allowedTools = new Set(getRestrictedModeTools());
		if (!allowedTools.has(event.toolName)) {
			return {
				block: true,
				reason: `Read-only mode: tool blocked (${event.toolName}). Allowed tools: ${[...allowedTools].join(", ")}`,
			};
		}

		if (event.toolName !== "bash") return;
		const command =
			typeof (event.input as { command?: unknown }).command === "string" ? (event.input as { command: string }).command : "";
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Read-only mode: command blocked (not allowlisted).\nCommand: ${command}`,
			};
		}
	});

	pi.on("context", async (event) => ({
		messages: event.messages.filter((message) => (message as { customType?: string }).customType !== READ_ONLY_CONTEXT_TYPE),
	}));

	pi.on("before_agent_start", async () => {
		if (!readOnlyEnabled) return;
		const lines: string[] = [];
		lines.push("[READ-ONLY MODE]");
		lines.push("Read-only mode is active.");
		lines.push("");
		lines.push("Restrictions:");
		lines.push(`- You can only use: ${getRestrictedModeTools().join(", ")}`);
		lines.push("- Do not modify project files, dependencies, the environment, or git state.");
		lines.push("- Bash is restricted to an allowlist of read-only commands.");
		lines.push("");
		lines.push("Guidance:");
		lines.push("- Inspect, analyze, explain, and propose changes.");
		lines.push("- If changes are needed, describe them clearly instead of trying to make them.");
		lines.push("- Ask clarifying questions when useful.");
		lines.push("- Do not attempt to bypass these restrictions.");
		return {
			message: {
				customType: READ_ONLY_CONTEXT_TYPE,
				content: lines.join("\n"),
				display: false,
			},
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		syncStateFromSession(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		syncStateFromSession(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		syncStateFromSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		syncStateFromSession(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		currentCtx = ctx;
		installUI(ctx);
	});
}
