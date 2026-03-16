import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	applyCompletedSteps,
	extractDoneSteps,
	extractTodoItems,
	isSafeCommand,
	normalizeStepNumbers,
	type TodoItem,
} from "./utils.js";

const BASE_PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", "worktree_info"] as const;
const OPTIONAL_PLAN_MODE_TOOLS = ["web_fetch"] as const;
const PLAN_MODE_CONTEXT_TYPE = "plan-mode-context";
const PLAN_EXECUTION_CONTEXT_TYPE = "plan-execution-context";
const PLAN_EXECUTE_MESSAGE_TYPE = "plan-mode-execute";
const PLAN_MODE_STATE_TYPE = "plan-mode";
const PLAN_TODO_LIST_MESSAGE_TYPE = "plan-todo-list";
const PLAN_PROGRESS_MESSAGE_TYPE = "plan-progress-update";
const PLAN_COMPLETE_MESSAGE_TYPE = "plan-complete";
const PLAN_STEP_DONE_TOOL = "plan_step_done";
const MODE_STATE_EVENT = "pi-config:mode-state";
const UI_ONLY_CUSTOM_MESSAGE_TYPES = new Set([
	PLAN_TODO_LIST_MESSAGE_TYPE,
	PLAN_PROGRESS_MESSAGE_TYPE,
	PLAN_COMPLETE_MESSAGE_TYPE,
]);

const PlanStepDoneParams = Type.Object({
	step: Type.Optional(Type.Integer({ description: "Single completed plan step number", minimum: 1 })),
	steps: Type.Optional(
		Type.Array(Type.Integer({ description: "Completed plan step number", minimum: 1 }), {
			description: "One or more completed plan step numbers",
			minItems: 1,
		}),
	),
	note: Type.Optional(Type.String({ description: "Optional short note about what was completed" })),
});

interface PersistedPlanModeState {
	enabled?: boolean;
	executing?: boolean;
	todoTrackingEnabled?: boolean;
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

interface ToolResultMessageLike {
	role: string;
	toolName?: string;
	details?: unknown;
}

interface PlanStepDoneDetails {
	completedSteps?: number[];
	alreadyCompletedSteps?: number[];
	invalidSteps?: number[];
	totalCompleted?: number;
	totalSteps?: number;
	note?: string | null;
	error?: string;
}

interface ModeStateEvent {
	mode?: string;
	active?: boolean;
	restoreTools?: string[] | null;
}

function isAssistantMessage(message: unknown): message is AssistantMessageLike {
	return (
		!!message &&
		typeof message === "object" &&
		(message as { role?: string }).role === "assistant" &&
		Array.isArray((message as { content?: unknown }).content)
	);
}

function isToolResultMessage(message: unknown): message is ToolResultMessageLike {
	return !!message && typeof message === "object" && (message as { role?: string }).role === "toolResult";
}

function getTextContent(message: AssistantMessageLike): string {
	return message.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function getLatestPlanTodoItems(entries: SessionEntryLike[]): TodoItem[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const message = entries[i]?.message;
		if (!isAssistantMessage(message)) continue;

		const extracted = extractTodoItems(getTextContent(message));
		if (extracted.length > 0) {
			return extracted;
		}
	}

	return [];
}

function getPlanStepDoneSteps(message: unknown): number[] {
	if (!isToolResultMessage(message) || message.toolName !== PLAN_STEP_DONE_TOOL) return [];
	const details = message.details as PlanStepDoneDetails | undefined;
	return normalizeStepNumbers(Array.isArray(details?.completedSteps) ? details.completedSteps : []);
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let currentCtx: ExtensionContext | undefined;
	let planModeEnabled = false;
	let executionMode = false;
	let todoTrackingEnabled = false;
	let todoItems: TodoItem[] = [];
	let restoreTools: string[] | null = null;
	let executionTools: string[] | null = null;
	let readOnlyModeActive = false;
	let readOnlyModeRestoreTools: string[] | null = null;
	let pendingProgressSteps: number[] = [];

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

	function getSessionBranchEntries(ctx?: ExtensionContext): SessionEntryLike[] {
		const activeCtx = ctx ?? currentCtx;
		if (!activeCtx) return [];
		return activeCtx.sessionManager.getBranch() as SessionEntryLike[];
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

	function getExecutionModeTools(): string[] {
		const normalizedExecutionTools = sanitizeToolNames(executionTools);
		const normalizedRestoreTools = sanitizeToolNames(restoreTools);
		const baseTools = normalizedExecutionTools.length > 0 ? normalizedExecutionTools : normalizedRestoreTools;
		if (executionMode && hasTrackedTodoItems()) {
			return sanitizeToolNames([...baseTools, PLAN_STEP_DONE_TOOL]);
		}
		return baseTools;
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
		const nextTools = getExecutionModeTools();
		if (nextTools.length > 0) {
			pi.setActiveTools(nextTools);
			return;
		}
		applyRestoreTools();
	}

	function hasTrackedTodoItems(): boolean {
		return todoTrackingEnabled && todoItems.length > 0;
	}

	function clearPendingProgressSteps(): void {
		pendingProgressSteps = [];
	}

	function resetTodoTracking(): void {
		todoTrackingEnabled = false;
		todoItems = [];
		clearPendingProgressSteps();
	}

	function getTrackedPlanItemsFromSession(ctx?: ExtensionContext): TodoItem[] {
		return getLatestPlanTodoItems(getSessionBranchEntries(ctx));
	}

	function getCompletedTodoCount(items: TodoItem[] = todoItems): number {
		return items.filter((item) => item.completed).length;
	}

	function formatTodoList(items: TodoItem[]): string {
		return items.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
	}

	function formatTodoChecklist(items: TodoItem[]): string {
		return items
			.map((item, i) => `${i + 1}. ${item.completed ? `~~${item.text}~~` : `☐ ${item.text}`}`)
			.join("\n");
	}

	function parseTodosCommand(args: string | undefined): "show" | "on" | "off" | null {
		const normalized = (args ?? "").trim().toLowerCase();
		if (!normalized || normalized === "show" || normalized === "list" || normalized === "status") return "show";
		if (normalized === "on" || normalized === "enable") return "on";
		if (normalized === "off" || normalized === "disable" || normalized === "clear") return "off";
		return null;
	}

	function queueProgressSteps(steps: number[]): void {
		const seen = new Set(pendingProgressSteps);
		for (const step of normalizeStepNumbers(steps)) {
			if (seen.has(step)) continue;
			pendingProgressSteps.push(step);
			seen.add(step);
		}
	}

	function emitProgressUpdateMessage(steps: number[]): void {
		if (!hasTrackedTodoItems()) return;
		const completed = getCompletedTodoCount();
		const stepSummary =
			steps.length === 1 ? `Completed step ${steps[0]}.` : `Completed steps ${steps.join(", ")}.`;
		pi.sendMessage(
			{
				customType: PLAN_PROGRESS_MESSAGE_TYPE,
				content: `**Plan Progress (${completed}/${todoItems.length} complete)**\n\n${stepSummary}\n\n${formatTodoChecklist(todoItems)}`,
				display: true,
			},
			{ triggerTurn: false },
		);
	}

	function markTrackedStepsCompleted(
		steps: number[],
		options?: { ctx?: ExtensionContext; persist?: boolean; queueProgress?: boolean },
	): number[] {
		if (!todoTrackingEnabled || todoItems.length === 0) return [];

		const completedNow = applyCompletedSteps(steps, todoItems);
		if (completedNow.length === 0) return [];

		if (options?.queueProgress !== false) {
			queueProgressSteps(completedNow);
		}
		updateStatus(options?.ctx);
		if (options?.persist !== false) {
			persistState();
		}
		return completedNow;
	}

	function collectCompletionStepsSinceExecution(entries: SessionEntryLike[]): number[] {
		let executeIndex = -1;
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i].customType === PLAN_EXECUTE_MESSAGE_TYPE) {
				executeIndex = i;
				break;
			}
		}

		const completionSteps: number[] = [];
		for (let i = executeIndex + 1; i < entries.length; i++) {
			const message = entries[i]?.message;
			completionSteps.push(...getPlanStepDoneSteps(message));
			if (isAssistantMessage(message)) {
				completionSteps.push(...extractDoneSteps(getTextContent(message)));
			}
		}

		return normalizeStepNumbers(completionSteps);
	}

	function updateStatus(ctx?: ExtensionContext): void {
		const activeCtx = ctx ?? currentCtx;
		if (!activeCtx?.hasUI) return;

		const trackedExecutionActive = executionMode && hasTrackedTodoItems();
		if (trackedExecutionActive) {
			activeCtx.ui.setStatus(
				"plan-mode",
				activeCtx.ui.theme.fg("accent", `📋 ${getCompletedTodoCount()}/${todoItems.length}`),
			);
		} else if (planModeEnabled) {
			activeCtx.ui.setStatus("plan-mode", activeCtx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			activeCtx.ui.setStatus("plan-mode", undefined);
		}

		if (trackedExecutionActive) {
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
			todoTrackingEnabled,
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
		resetTodoTracking();
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
		resetTodoTracking();
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
		executionMode = hasTrackedTodoItems();
		clearPendingProgressSteps();
		if (!executionMode) {
			resetTodoTracking();
		}
		applyExecutionTools();
		updateStatus(ctx);
		persistState();
		emitModeState();
	}

	function completeExecution(ctx?: ExtensionContext): void {
		executionMode = false;
		resetTodoTracking();
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
		todoTrackingEnabled = false;
		todoItems = [];
		restoreTools = null;
		executionTools = null;
		clearPendingProgressSteps();

		const entries = getSessionBranchEntries(ctx);
		const planModeEntry = entries
			.filter((entry) => entry.type === "custom" && entry.customType === PLAN_MODE_STATE_TYPE)
			.pop() as SessionEntryLike | undefined;
		const persisted = planModeEntry?.data;

		if (persisted) {
			planModeEnabled = persisted.enabled ?? false;
			executionMode = persisted.executing ?? false;
			todoItems = persisted.todos ?? [];
			todoTrackingEnabled = persisted.todoTrackingEnabled ?? (executionMode || todoItems.length > 0);
			restoreTools = sanitizeToolNames(persisted.restoreTools ?? null);
			executionTools = sanitizeToolNames(persisted.executionTools ?? null);
		}

		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
			executionMode = false;
			resetTodoTracking();
		}

		if (!todoTrackingEnabled) {
			todoItems = [];
			executionMode = false;
		} else if (todoItems.length === 0) {
			executionMode = false;
		}

		if (!planModeEnabled && !executionMode && todoItems.length === 0) {
			todoTrackingEnabled = false;
		}

		if (!restoreTools || restoreTools.length === 0) {
			restoreTools = getUnderlyingRestoreTools();
		}
		if (!executionTools || executionTools.length === 0) {
			executionTools = sanitizeToolNames(restoreTools);
		}

		if (executionMode && hasTrackedTodoItems()) {
			markTrackedStepsCompleted(collectCompletionStepsSinceExecution(entries), {
				ctx,
				persist: false,
				queueProgress: false,
			});
		}

		if (planModeEnabled) {
			pi.setActiveTools(getPlanModeTools());
		} else if (executionMode) {
			applyExecutionTools();
		}

		updateStatus(ctx);
		emitModeState();
	}

	pi.registerTool({
		name: PLAN_STEP_DONE_TOOL,
		label: "Plan Step Done",
		description: "Mark one or more tracked plan steps complete during tracked plan execution.",
		promptSnippet: "Mark tracked plan step(s) complete during tracked plan execution",
		promptGuidelines: [
			"Only use this during tracked plan execution.",
			"Call it immediately when you complete a tracked step, instead of relying on prose-only progress markers.",
			"Use the exact tracked step numbers from the current plan.",
		],
		parameters: PlanStepDoneParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const toolCtx = ctx as ExtensionContext;
			currentCtx = toolCtx;
			if (!executionMode || !hasTrackedTodoItems()) {
				return {
					content: [{ type: "text", text: "Plan step tracking is not active right now." }],
					details: { error: "tracking not active" } satisfies PlanStepDoneDetails,
				};
			}

			const requestedSteps = normalizeStepNumbers([
				...(params.step !== undefined ? [params.step] : []),
				...(params.steps ?? []),
			]);
			if (requestedSteps.length === 0) {
				return {
					content: [{ type: "text", text: "No plan step numbers were provided." }],
					details: { error: "no step numbers provided" } satisfies PlanStepDoneDetails,
				};
			}

			const validStepSet = new Set(todoItems.map((item) => item.step));
			const completedBefore = new Set(todoItems.filter((item) => item.completed).map((item) => item.step));
			const invalidSteps = requestedSteps.filter((step) => !validStepSet.has(step));
			const validSteps = requestedSteps.filter((step) => validStepSet.has(step));
			const completedSteps = markTrackedStepsCompleted(validSteps, { ctx: toolCtx });
			const alreadyCompletedSteps = validSteps.filter((step) => completedBefore.has(step));
			const totalCompleted = getCompletedTodoCount();
			const noteSuffix = params.note?.trim() ? ` Note: ${params.note.trim()}` : "";

			let text = "No tracked plan steps changed.";
			if (completedSteps.length > 0) {
				text = `Marked plan step${completedSteps.length === 1 ? "" : "s"} ${completedSteps.join(", ")} complete (${totalCompleted}/${todoItems.length}).${noteSuffix}`;
			} else if (alreadyCompletedSteps.length > 0 && invalidSteps.length === 0) {
				text = `Plan step${alreadyCompletedSteps.length === 1 ? "" : "s"} ${alreadyCompletedSteps.join(", ")} ${alreadyCompletedSteps.length === 1 ? "is" : "are"} already complete (${totalCompleted}/${todoItems.length}).${noteSuffix}`;
			} else if (invalidSteps.length > 0) {
				text = `Ignored invalid plan step${invalidSteps.length === 1 ? "" : "s"} ${invalidSteps.join(", ")} (${totalCompleted}/${todoItems.length}).${noteSuffix}`;
			}

			return {
				content: [{ type: "text", text }],
				details: {
					completedSteps,
					alreadyCompletedSteps,
					invalidSteps,
					totalCompleted,
					totalSteps: todoItems.length,
					note: params.note?.trim() || null,
				} satisfies PlanStepDoneDetails,
			};
		},
	});

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
		description: "Manage optional plan task tracking (show|on|off)",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const action = parseTodosCommand(args);
			if (!action) {
				notify(ctx, "Usage: /todos [show|on|off]");
				return;
			}

			if (action === "on") {
				if (!planModeEnabled && !executionMode) {
					notify(ctx, "Task tracking works with /plan. Enable /plan first, then run /todos on.");
					return;
				}

				todoTrackingEnabled = true;
				if (todoItems.length === 0) {
					const extracted = getTrackedPlanItemsFromSession(ctx);
					if (extracted.length > 0) {
						todoItems = extracted;
					}
				}

				updateStatus(ctx);
				persistState();

				if (todoItems.length === 0) {
					notify(ctx, "Task tracking enabled. Once the assistant produces a numbered Plan: block, /todos will show the tracked steps.");
					return;
				}

				notify(ctx, `Task tracking enabled.\n\nPlan Progress:\n${formatTodoList(todoItems)}`);
				return;
			}

			if (action === "off") {
				const wasTrackedExecution = executionMode && hasTrackedTodoItems();
				executionMode = false;
				resetTodoTracking();
				if (!planModeEnabled) {
					applyExecutionTools();
				}
				updateStatus(ctx);
				persistState();
				emitModeState();
				notify(
					ctx,
					wasTrackedExecution
						? "Task tracking disabled. Plan execution will continue without tracked progress."
						: "Task tracking disabled.",
				);
				return;
			}

			if (!todoTrackingEnabled) {
				notify(ctx, "Task tracking is off. Use /todos on to enable it for the current plan.");
				return;
			}

			if (todoItems.length === 0) {
				const extracted = getTrackedPlanItemsFromSession(ctx);
				if (extracted.length > 0) {
					todoItems = extracted;
					persistState();
				}
			}

			if (todoItems.length === 0) {
				notify(ctx, "Task tracking is enabled, but no numbered Plan: steps have been captured yet.");
				return;
			}

			notify(ctx, `Plan Progress:\n${formatTodoList(todoItems)}`);
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

				if (msg.customType && UI_ONLY_CUSTOM_MESSAGE_TYPES.has(msg.customType)) return false;
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
			const trackingLine = todoTrackingEnabled
				? "- Task tracking is enabled for this plan. Keep numbered steps stable so they can be tracked later.\n"
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
${webResearchLine}${trackingLine}- Inspect the codebase, gather evidence, and think through tradeoffs.
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

		if (executionMode && hasTrackedTodoItems()) {
			const remaining = todoItems.filter((item) => !item.completed);
			const todoList = remaining.map((item) => `${item.step}. ${item.text}`).join("\n");
			return {
				message: {
					customType: PLAN_EXECUTION_CONTEXT_TYPE,
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
When you finish a tracked step, call ${PLAN_STEP_DONE_TOOL} immediately with the completed step number.
If you complete multiple tracked steps together, you may mark them in one call.
Do not rely on prose-only progress updates.`,
					display: false,
				},
			};
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		currentCtx = ctx;
		if (!executionMode || !hasTrackedTodoItems()) {
			clearPendingProgressSteps();
			return;
		}

		if (isAssistantMessage(event.message)) {
			const doneSteps = extractDoneSteps(getTextContent(event.message));
			if (doneSteps.length > 0) {
				markTrackedStepsCompleted(doneSteps, { ctx });
			}
		}

		const completedThisTurn = [...pendingProgressSteps];
		clearPendingProgressSteps();
		if (completedThisTurn.length > 0 && !todoItems.every((item) => item.completed)) {
			emitProgressUpdateMessage(completedThisTurn);
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		currentCtx = ctx;
		if (executionMode && hasTrackedTodoItems()) {
			if (todoItems.every((item) => item.completed)) {
				const completedList = todoItems.map((item) => `~~${item.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: PLAN_COMPLETE_MESSAGE_TYPE, content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				completeExecution(ctx);
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		if (todoTrackingEnabled) {
			const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
			if (lastAssistant) {
				const extracted = extractTodoItems(getTextContent(lastAssistant));
				if (extracted.length > 0) {
					todoItems = extracted;
					persistState();
				}
			}
		}

		if (todoTrackingEnabled && todoItems.length > 0) {
			pi.sendMessage(
				{
					customType: PLAN_TODO_LIST_MESSAGE_TYPE,
					content: `**Plan Steps (${todoItems.length}):**\n\n${formatTodoChecklist(todoItems)}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		}

		const choice = await ctx.ui.select("Plan mode - what next?", [
			todoTrackingEnabled && todoItems.length > 0 ? "Execute the plan (track progress)" : "Execute the plan",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			startExecution(ctx);
			const execMessage =
				executionMode && todoItems.length > 0 ? `Execute the plan. Start with: ${todoItems[0].text}` : "Execute the plan you just created.";
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
