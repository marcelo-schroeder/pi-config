import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { isSafeCommand } from "./utils.js";

const BASE_READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", "worktree_info"] as const;
const OPTIONAL_READ_ONLY_TOOLS = ["web_fetch"] as const;
const READ_ONLY_CONTEXT_TYPE = "read-only-mode-context";
const READ_ONLY_STATE_TYPE = "read-only-mode";
const MODE_STATE_EVENT = "pi-config:mode-state";

interface PersistedReadOnlyState {
	enabled?: boolean;
	restoreTools?: string[] | null;
}

interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: PersistedReadOnlyState;
}

interface ModeStateEvent {
	mode?: string;
	active?: boolean;
	restoreTools?: string[] | null;
}

export default function readOnlyModeExtension(pi: ExtensionAPI): void {
	let currentCtx: ExtensionContext | undefined;
	let readOnlyEnabled = false;
	let restoreTools: string[] | null = null;
	let planModeActive = false;
	let planModeRestoreTools: string[] | null = null;

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

	function getReadOnlyTools(): string[] {
		const available = getAvailableToolNames();
		const requiredTools = BASE_READ_ONLY_TOOLS.filter((name) => available.has(name));
		const optionalTools = OPTIONAL_READ_ONLY_TOOLS.filter((name) => available.has(name));
		return [...requiredTools, ...optionalTools];
	}

	function applyRestoreTools(): void {
		const normalizedRestoreTools = sanitizeToolNames(restoreTools);
		if (normalizedRestoreTools.length > 0) {
			pi.setActiveTools(normalizedRestoreTools);
		}
	}

	function updateStatus(ctx?: ExtensionContext): void {
		const activeCtx = ctx ?? currentCtx;
		if (!activeCtx?.hasUI) return;

		if (readOnlyEnabled) {
			activeCtx.ui.setStatus("read-only-mode", activeCtx.ui.theme.fg("warning", "🔒 read-only"));
		} else {
			activeCtx.ui.setStatus("read-only-mode", undefined);
		}
	}

	function notify(ctx: ExtensionContext | undefined, message: string): void {
		if (ctx?.hasUI) {
			ctx.ui.notify(message, "info");
		}
	}

	function persistState(): void {
		pi.appendEntry(READ_ONLY_STATE_TYPE, {
			enabled: readOnlyEnabled,
			restoreTools,
		});
	}

	function emitModeState(): void {
		pi.events.emit(MODE_STATE_EVENT, {
			mode: "read-only",
			active: readOnlyEnabled,
			restoreTools: sanitizeToolNames(restoreTools),
		});
	}

	function getUnderlyingRestoreTools(): string[] {
		const peerRestoreTools = sanitizeToolNames(planModeRestoreTools);
		if (planModeActive && peerRestoreTools.length > 0) {
			return peerRestoreTools;
		}
		return sanitizeToolNames(getCurrentActiveTools());
	}

	function enableReadOnly(ctx?: ExtensionContext, options?: { silent?: boolean }): void {
		const uiCtx = ctx ?? currentCtx;
		const nextRestoreTools = getUnderlyingRestoreTools();
		if (nextRestoreTools.length > 0) {
			restoreTools = nextRestoreTools;
		}

		readOnlyEnabled = true;
		pi.setActiveTools(getReadOnlyTools());
		updateStatus(uiCtx);
		persistState();
		emitModeState();

		if (!options?.silent) {
			notify(uiCtx, `Read-only mode enabled. Tools: ${getReadOnlyTools().join(", ")}`);
		}
	}

	function disableReadOnly(
		ctx?: ExtensionContext,
		options?: { silent?: boolean; restoreToolsOnExit?: boolean },
	): void {
		const uiCtx = ctx ?? currentCtx;
		readOnlyEnabled = false;
		if (options?.restoreToolsOnExit !== false) {
			applyRestoreTools();
		}
		updateStatus(uiCtx);
		persistState();
		emitModeState();

		if (!options?.silent) {
			notify(uiCtx, "Read-only mode disabled. Previous tool set restored.");
		}
	}

	function resetPeerState(): void {
		planModeActive = false;
		planModeRestoreTools = null;
	}

	async function syncStateFromSession(ctx: ExtensionContext): Promise<void> {
		currentCtx = ctx;
		readOnlyEnabled = false;
		restoreTools = null;

		const entries = ctx.sessionManager.getEntries() as SessionEntryLike[];
		const readOnlyEntry = entries
			.filter((entry) => entry.type === "custom" && entry.customType === READ_ONLY_STATE_TYPE)
			.pop() as SessionEntryLike | undefined;
		const persisted = readOnlyEntry?.data;

		if (persisted) {
			readOnlyEnabled = persisted.enabled ?? false;
			restoreTools = sanitizeToolNames(persisted.restoreTools ?? null);
		}

		if (!restoreTools || restoreTools.length === 0) {
			restoreTools = getUnderlyingRestoreTools();
		}

		if (readOnlyEnabled && !planModeActive) {
			pi.setActiveTools(getReadOnlyTools());
		} else if (!persisted && !planModeActive) {
			const nextRestoreTools = getUnderlyingRestoreTools();
			if (nextRestoreTools.length > 0) {
				restoreTools = nextRestoreTools;
			}
			readOnlyEnabled = true;
			pi.setActiveTools(getReadOnlyTools());
		} else {
			readOnlyEnabled = false;
		}

		updateStatus(ctx);
		emitModeState();
	}

	pi.events.on(MODE_STATE_EVENT, (data) => {
		const event = data as ModeStateEvent;
		if (event.mode !== "plan") return;

		planModeActive = event.active === true;
		planModeRestoreTools = sanitizeToolNames(event.restoreTools ?? null);

		if (planModeActive && readOnlyEnabled) {
			disableReadOnly(undefined, { silent: true, restoreToolsOnExit: false });
		}
	});

	pi.registerCommand("readonly", {
		description: "Toggle read-only mode",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			if (readOnlyEnabled) {
				disableReadOnly(ctx);
				return;
			}
			enableReadOnly(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("r"), {
		description: "Toggle read-only mode",
		handler: async (ctx) => {
			currentCtx = ctx;
			if (readOnlyEnabled) {
				disableReadOnly(ctx);
				return;
			}
			enableReadOnly(ctx);
		},
	});

	pi.on("tool_call", async (event) => {
		if (!readOnlyEnabled) return;

		const allowedTools = new Set(getReadOnlyTools());
		if (!allowedTools.has(event.toolName)) {
			return {
				block: true,
				reason: `Read-only mode: tool blocked (${event.toolName}). Allowed tools: ${[...allowedTools].join(", ")}`,
			};
		}

		if (event.toolName !== "bash") return;

		const command = typeof (event.input as { command?: unknown }).command === "string" ? (event.input as { command: string }).command : "";
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Read-only mode: command blocked (not allowlisted). Disable read-only mode first if you want to run it.\nCommand: ${command}`,
			};
		}
	});

	pi.on("context", async (event) => {
		if (readOnlyEnabled) return;
		return {
			messages: event.messages.filter((message) => (message as { customType?: string }).customType !== READ_ONLY_CONTEXT_TYPE),
		};
	});

	pi.on("before_agent_start", async () => {
		if (!readOnlyEnabled) return;

		const tools = getReadOnlyTools().join(", ");
		const bashLine = getReadOnlyTools().includes("bash")
			? "- Bash is restricted to an allowlist of read-only commands.\n"
			: "";
		return {
			message: {
				customType: READ_ONLY_CONTEXT_TYPE,
				content: `[READ-ONLY MODE ACTIVE]
You are in read-only mode.

Restrictions:
- You can only use: ${tools}
- You must not modify code, files, git state, dependencies, or the environment.
${bashLine}
Guidance:
- Inspect, analyze, explain, and propose changes.
- If changes are needed, describe them clearly instead of trying to make them.
- Ask clarifying questions when needed.
- Do not attempt to bypass these restrictions.`,
				display: false,
			},
		};
	});

	pi.on("session_before_switch", async () => {
		resetPeerState();
	});

	pi.on("session_before_fork", async () => {
		resetPeerState();
	});

	pi.on("session_start", async (_event, ctx) => {
		await syncStateFromSession(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await syncStateFromSession(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		await syncStateFromSession(ctx);
	});
}
