import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.js";

const BASE_PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", "worktree_info"] as const;
const OPTIONAL_PLAN_MODE_TOOLS = ["web_fetch"] as const;
const PLAN_MODE_CONTEXT_TYPE = "plan-mode-context";
const PLAN_EXECUTION_CONTEXT_TYPE = "plan-execution-context";
const PLAN_EXECUTE_MESSAGE_TYPE = "plan-mode-execute";
const PLAN_MODE_STATE_TYPE = "plan-mode";
const MODE_STATE_EVENT = "pi-config:mode-state";

interface PersistedPlanModeState {
	enabled?: boolean;
	executing?: boolean;
	todos?: TodoItem[];
	restoreTools?: string[] | null;
	executionTools?: string[] | null;
}

interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: PersistedPlanModeState;
	message?: unknown;
}

interface AssistantMessageLike {
	role: string;
	content: Array<{ type?: string; text?: string }>;
}

interface ModeStateEvent {
	mode?: string;
	active?: boolean;
	restoreTools?: string[] | null;
}

function isAssistantMessage(message: unknown): message is AssistantMessageLike {
	return !!message && typeof message === "object" && (message as { role?: string }).role === "assistant" && Array.isArray((message as { content?: unknown }).content);
}

function getTextContent(message: AssistantMessageLike): string {
	return message.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let currentCtx: ExtensionContext | undefined;
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let restoreTools: string[] | null = null;
	let executionTools: string[] | null = null;
	let readOnlyModeActive = false;
	let readOnlyModeRestoreTools: string[] | null = null;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

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

	function getPlanModeTools(): string[] {
		const available = getAvailableToolNames();
		const requiredTools = BASE_PLAN_MODE_TOOLS.filter((name) => available.has(name));
		const optionalTools = OPTIONAL_PLAN_MODE_TOOLS.filter((name) => available.has(name));
		return [...requiredTools, ...optionalTools];
	}

	function hasOptionalWebFetch(): boolean {
		return getPlanModeTools().includes("web_fetch");
	}

	function applyRestoreTools(): void {
		const normalizedRestoreTools = sanitizeToolNames(restoreTools);
		if (normalizedRestoreTools.length > 0) {
			pi.setActiveTools(normalizedRestoreTools);
		}
	}

	function applyExecutionTools(): void {
		const normalizedExecutionTools = sanitizeToolNames(executionTools);
		if (normalizedExecutionTools.length > 0) {
			pi.setActiveTools(normalizedExecutionTools);
			return;
		}
		applyRestoreTools();
	}

	function updateStatus(ctx?: ExtensionContext): void {
		const activeCtx = ctx ?? currentCtx;
		if (!activeCtx?.hasUI) return;

		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((item) => item.completed).length;
			activeCtx.ui.setStatus("plan-mode", activeCtx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			activeCtx.ui.setStatus("plan-mode", activeCtx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			activeCtx.ui.setStatus("plan-mode", undefined);
		}

		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return activeCtx.ui.theme.fg("success", "☑ ") + activeCtx.ui.theme.fg("muted", activeCtx.ui.theme.strikethrough(item.text));
				}
				return `${activeCtx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			activeCtx.ui.setWidget("plan-todos", lines);
		} else {
			activeCtx.ui.setWidget("plan-todos", undefined);
		}
	}

	function notify(ctx: ExtensionContext | undefined, message: string): void {
		if (ctx?.hasUI) {
			ctx.ui.notify(message, "info");
		}
	}

	function persistState(): void {
		pi.appendEntry(PLAN_MODE_STATE_TYPE, {
			enabled: planModeEnabled,
			executing: executionMode,
			todos: todoItems,
			restoreTools,
			executionTools,
		});
	}

	function emitModeState(): void {
		pi.events.emit(MODE_STATE_EVENT, {
			mode: "plan",
			active: planModeEnabled || executionMode,
			restoreTools: sanitizeToolNames(restoreTools),
		});
	}

	function getUnderlyingRestoreTools(): string[] {
		const peerRestoreTools = sanitizeToolNames(readOnlyModeRestoreTools);
		if (readOnlyModeActive && peerRestoreTools.length > 0) {
			return peerRestoreTools;
		}
		return sanitizeToolNames(getCurrentActiveTools());
	}

	function enablePlanMode(ctx?: ExtensionContext, options?: { silent?: boolean }): void {
		const uiCtx = ctx ?? currentCtx;
		const baseRestoreTools = getUnderlyingRestoreTools();
		if (baseRestoreTools.length > 0) {
			restoreTools = baseRestoreTools;
			executionTools = baseRestoreTools;
		}

		planModeEnabled = true;
		executionMode = false;
		todoItems = [];
		pi.setActiveTools(getPlanModeTools());
		updateStatus(uiCtx);
		persistState();
		emitModeState();

		if (!options?.silent) {
			notify(uiCtx, `Plan mode enabled. Tools: ${getPlanModeTools().join(", ")}`);
		}
	}

	function disablePlanWorkflow(
		ctx?: ExtensionContext,
		options?: { silent?: boolean; restoreToolsOnExit?: boolean; message?: string },
	): void {
		const uiCtx = ctx ?? currentCtx;
		planModeEnabled = false;
		executionMode = false;
		todoItems = [];
		if (options?.restoreToolsOnExit !== false) {
			applyRestoreTools();
		}
		updateStatus(uiCtx);
		persistState();
		emitModeState();

		if (!options?.silent) {
			notify(uiCtx, options?.message ?? "Plan mode disabled. Previous tool set restored.");
		}
	}

	function startExecution(ctx?: ExtensionContext): void {
		planModeEnabled = false;
		executionMode = todoItems.length > 0;
		applyExecutionTools();
		updateStatus(ctx);
		persistState();
		emitModeState();
	}

	function completeExecution(ctx?: ExtensionContext): void {
		executionMode = false;
		todoItems = [];
		applyRestoreTools();
		updateStatus(ctx);
		persistState();
		emitModeState();
	}

	function resetPeerState(): void {
		readOnlyModeActive = false;
		readOnlyModeRestoreTools = null;
	}

	async function syncStateFromSession(ctx: ExtensionContext): Promise<void> {
		currentCtx = ctx;
		planModeEnabled = false;
		executionMode = false;
		todoItems = [];
		restoreTools = null;
		executionTools = null;

		const entries = ctx.sessionManager.getEntries() as SessionEntryLike[];
		const planModeEntry = entries
			.filter((entry) => entry.type === "custom" && entry.customType === PLAN_MODE_STATE_TYPE)
			.pop() as SessionEntryLike | undefined;
		const persisted = planModeEntry?.data;

		if (persisted) {
			planModeEnabled = persisted.enabled ?? false;
			executionMode = persisted.executing ?? false;
			todoItems = persisted.todos ?? [];
			restoreTools = sanitizeToolNames(persisted.restoreTools ?? null);
			executionTools = sanitizeToolNames(persisted.executionTools ?? null);
		}

		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
			executionMode = false;
			todoItems = [];
		}

		if (!restoreTools || restoreTools.length === 0) {
			restoreTools = getUnderlyingRestoreTools();
		}
		if (!executionTools || executionTools.length === 0) {
			executionTools = sanitizeToolNames(restoreTools);
		}

		if (planModeEnabled) {
			pi.setActiveTools(getPlanModeTools());
		} else if (executionMode) {
			applyExecutionTools();
		}

		if (executionMode && todoItems.length > 0) {
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				if (entries[i].customType === PLAN_EXECUTE_MESSAGE_TYPE) {
					executeIndex = i;
					break;
				}
			}

			const messages: AssistantMessageLike[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const message = entries[i]?.message;
				if (isAssistantMessage(message)) {
					messages.push(message);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		updateStatus(ctx);
		emitModeState();
	}

	pi.events.on(MODE_STATE_EVENT, (data) => {
		const event = data as ModeStateEvent;
		if (event.mode !== "read-only") return;

		readOnlyModeActive = event.active === true;
		readOnlyModeRestoreTools = sanitizeToolNames(event.restoreTools ?? null);

		if (readOnlyModeActive && (planModeEnabled || executionMode)) {
			disablePlanWorkflow(undefined, { silent: true, restoreToolsOnExit: false });
		}
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			if (planModeEnabled || executionMode) {
				disablePlanWorkflow(ctx);
				return;
			}
			enablePlanMode(ctx);
		},
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			if (todoItems.length === 0) {
				ctx.ui.notify("No tracked plan items yet. Generate a plan first with /plan.", "info");
				return;
			}
			const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			currentCtx = ctx;
			if (planModeEnabled || executionMode) {
				disablePlanWorkflow(ctx);
				return;
			}
			enablePlanMode(ctx);
		},
	});

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		const allowedTools = new Set(getPlanModeTools());
		if (!allowedTools.has(event.toolName)) {
			return {
				block: true,
				reason: `Plan mode: tool blocked (${event.toolName}). Allowed tools: ${[...allowedTools].join(", ")}`,
			};
		}

		if (event.toolName !== "bash") return;

		const command = typeof (event.input as { command?: unknown }).command === "string" ? (event.input as { command: string }).command : "";
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Disable plan mode first if you really want to run it.\nCommand: ${command}`,
			};
		}
	});

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((message) => {
				const msg = message as { customType?: string; role?: string; content?: unknown };

				if (!planModeEnabled && msg.customType === PLAN_MODE_CONTEXT_TYPE) return false;
				if (!executionMode && msg.customType === PLAN_EXECUTION_CONTEXT_TYPE) return false;

				if (msg.role !== "user") return true;

				if (!planModeEnabled) {
					if (typeof msg.content === "string" && msg.content.includes("[PLAN MODE ACTIVE]")) return false;
					if (
						Array.isArray(msg.content) &&
						msg.content.some(
							(block) =>
								typeof block === "object" &&
								block !== null &&
								(block as { type?: string; text?: string }).type === "text" &&
								typeof (block as { text?: string }).text === "string" &&
								(block as { text: string }).text.includes("[PLAN MODE ACTIVE]"),
						)
					) {
						return false;
					}
				}

				if (!executionMode) {
					if (typeof msg.content === "string" && msg.content.includes("[EXECUTING PLAN - Full tool access enabled]")) return false;
					if (
						Array.isArray(msg.content) &&
						msg.content.some(
							(block) =>
								typeof block === "object" &&
								block !== null &&
								(block as { type?: string; text?: string }).type === "text" &&
								typeof (block as { text?: string }).text === "string" &&
								(block as { text: string }).text.includes("[EXECUTING PLAN - Full tool access enabled]"),
						)
					) {
						return false;
					}
				}

				return true;
			}),
		};
	});

	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			const tools = getPlanModeTools().join(", ");
			const webResearchLine = hasOptionalWebFetch()
				? "- Use web_fetch when you need external web research or documentation lookup.\n"
				: "";
			return {
				message: {
					customType: PLAN_MODE_CONTEXT_TYPE,
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: ${tools}
- You CANNOT use edit or write, and you should not make changes
- Bash is restricted to an allowlist of read-only commands

Guidance:
- Ask clarifying questions with the questionnaire tool when needed.
${webResearchLine}- Inspect the codebase, gather evidence, and think through tradeoffs.
- Create a detailed numbered plan under a "Plan:" header.

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes yet.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((item) => !item.completed);
			const todoList = remaining.map((item) => `${item.step}. ${item.text}`).join("\n");
			return {
				message: {
					customType: PLAN_EXECUTION_CONTEXT_TYPE,
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
					display: false,
				},
			};
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		currentCtx = ctx;
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
			persistState();
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		currentCtx = ctx;
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((item) => item.completed)) {
				const completedList = todoItems.map((item) => `~~${item.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				completeExecution(ctx);
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const extracted = extractTodoItems(getTextContent(lastAssistant));
			if (extracted.length > 0) {
				todoItems = extracted;
				persistState();
			}
		}

		if (todoItems.length > 0) {
			const todoListText = todoItems.map((item, i) => `${i + 1}. ☐ ${item.text}`).join("\n");
			pi.sendMessage(
				{
					customType: "plan-todo-list",
					content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		}

		const choice = await ctx.ui.select("Plan mode - what next?", [
			todoItems.length > 0 ? "Execute the plan (track progress)" : "Execute the plan",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			startExecution(ctx);
			const execMessage =
				todoItems.length > 0 ? `Execute the plan. Start with: ${todoItems[0].text}` : "Execute the plan you just created.";
			pi.sendMessage(
				{ customType: PLAN_EXECUTE_MESSAGE_TYPE, content: execMessage, display: true },
				{ triggerTurn: true },
			);
			return;
		}

		if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim());
			}
		}
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
