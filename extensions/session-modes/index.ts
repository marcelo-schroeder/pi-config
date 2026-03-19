import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { normalizeQuestions, runQuestionnaireUI } from "../questionnaire/ui.ts";
import { SessionModesEditor } from "./editor.ts";
import { installSessionModesFooter } from "./footer.ts";
import { generateFriendlyPlanId } from "./ids.ts";
import {
	buildPlanRecord,
	createDefaultState,
	formatPlanForContext,
	formatPlanForDisplay,
	formatPlanList,
	reconstructSessionModes,
	SESSION_MODES_PLAN_TYPE,
	SESSION_MODES_STATE_TYPE,
	summarizePlans,
	updatePlanRecord,
} from "./plans.ts";
import { isSafeCommand } from "./safety.ts";
import type { PlanRecord, SessionMode, SessionPlanAction, SessionPlanSummary, SessionPlanToolDetails } from "./types.ts";

const SESSION_PLAN_TOOL = "session_plan";
const SESSION_MODES_CONTEXT_TYPE = "session-modes-context";
const IMPLEMENT_PLAN_COMMAND = "_session-modes-implement-plan";
const RESTRICTED_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", "worktree_info", SESSION_PLAN_TOOL] as const;
const OPTIONAL_RESTRICTED_TOOLS = ["web_fetch"] as const;
const IMPLEMENT_PLAN_CHOICES = normalizeQuestions([
	{
		id: "next",
		label: "Next",
		prompt: "What would you like to do next with this plan?",
		options: [
			{ value: "clean", label: "clean context and implement plan" },
			{ value: "keep", label: "keep context and implement plan" },
			{ value: "stay", label: "stay in plan mode" },
		],
		allowOther: false,
	},
]);

const SessionPlanParams = Type.Object({
	action: StringEnum(["create", "update", "show", "list", "select"] as const, {
		description: "Plan action to perform",
	}),
	planId: Type.Optional(Type.String({ description: "Specific plan id, e.g. calm-river-fox" })),
	title: Type.Optional(Type.String({ description: "Short plan title for create or update" })),
	summary: Type.Optional(Type.String({ description: "Optional short summary for create or update" })),
	steps: Type.Optional(
		Type.Array(Type.String({ description: "A single full plan step" }), {
			description: "Full ordered plan steps for create or update",
			minItems: 1,
		}),
	),
});

interface SessionEntryLike {
	type?: string;
	customType?: string;
	message?: unknown;
}

interface ToolResultMessageLike {
	role: string;
	toolName?: string;
	details?: unknown;
	content?: Array<{ type?: string; text?: string }>;
}

function isToolResultMessage(message: unknown): message is ToolResultMessageLike {
	return !!message && typeof message === "object" && (message as { role?: string }).role === "toolResult";
}

function trimToUndefined(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSteps(steps: unknown): string[] {
	if (!Array.isArray(steps)) return [];
	return steps
		.filter((step): step is string => typeof step === "string")
		.map((step) => step.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim())
		.filter((step) => step.length > 0);
}

function isPlanMutationPrompt(text: string): boolean {
	const normalized = text.toLowerCase();
	const showOnlyPatterns = [
		/\b(show|display|present|list|summarize|what is|what's|which|view)\b.{0,30}\bplan\b/,
		/\bplan id\b/,
		/\bplans\b.{0,10}\bdo we have\b/,
		/\bimplement\b.{0,30}\bplan\b/,
	];
	if (showOnlyPatterns.some((pattern) => pattern.test(normalized))) {
		return false;
	}

	const createPatterns = [
		/\b(create|make|draft|write|prepare|build)\b.{0,30}\b(plan|implementation plan)\b/,
		/\bcome up with\b.{0,20}\bplan\b/,
		/\bneed\b.{0,15}\bplan\b/,
	];
	const updatePatterns = [
		/\b(update|modify|change|revise|refine|adjust|rework|amend|expand)\b.{0,30}\bplan\b/,
		/\b(add|remove)\b.{0,30}\bplan\b/,
	];
	return createPatterns.some((pattern) => pattern.test(normalized)) || updatePatterns.some((pattern) => pattern.test(normalized));
}

function buildImplementationPrompt(plan: PlanRecord): string {
	const title = plan.title ? ` (${plan.title})` : "";
	return `Implement current plan ${plan.id}${title}.`;
}

function getPlanSummaries(plansById: Map<string, PlanRecord>, currentPlanId: string | null): SessionPlanSummary[] {
	return summarizePlans(plansById.values(), currentPlanId);
}

function buildPlanToolContent(details: SessionPlanToolDetails): string {
	if (details.action === "list") {
		return formatPlanList(details.plans);
	}
	if (details.plan) {
		const prefix = details.message ? `${details.message}\n\n` : "";
		return `${prefix}${formatPlanForDisplay(details.plan)}`;
	}
	return details.message ?? "No plan information available.";
}

function getPlanMutationFromMessages(messages: unknown[]): SessionPlanToolDetails | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!isToolResultMessage(message)) continue;
		if (message.toolName !== SESSION_PLAN_TOOL) continue;
		const details = message.details as SessionPlanToolDetails | undefined;
		if (!details?.plan) continue;
		if (details.action === "create" || details.action === "update") {
			return details;
		}
	}
	return null;
}

export default function sessionModesExtension(pi: ExtensionAPI): void {
	let currentCtx: ExtensionContext | undefined;
	let currentMode: SessionMode = "default";
	let currentPlanId: string | null = null;
	let restoreTools: string[] | null = null;
	let plansById = new Map<string, PlanRecord>();

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

	function getCurrentPlan(): PlanRecord | null {
		return currentPlanId ? plansById.get(currentPlanId) ?? null : null;
	}

	function installUI(ctx?: ExtensionContext): void {
		const activeCtx = ctx ?? currentCtx;
		if (!activeCtx?.hasUI) return;
		activeCtx.ui.setEditorComponent((tui, theme, keybindings) =>
			new SessionModesEditor(tui, theme, keybindings, {
				onCycleMode: () => {
					currentCtx = activeCtx;
					if (!activeCtx.isIdle()) {
						activeCtx.ui.notify("Wait until the agent is idle before cycling session modes.", "warning");
						return;
					}
					const nextMode: SessionMode =
						currentMode === "default" ? "read-only" : currentMode === "read-only" ? "plan" : "default";
					applyMode(nextMode, activeCtx);
				},
			}),
		);
		installSessionModesFooter(pi, activeCtx, currentMode);
	}

	function persistState(): void {
		pi.appendEntry(SESSION_MODES_STATE_TYPE, {
			mode: currentMode,
			currentPlanId,
			restoreTools: sanitizeToolNames(restoreTools),
		});
	}

	function persistPlan(plan: PlanRecord): void {
		plansById.set(plan.id, plan);
		pi.appendEntry(SESSION_MODES_PLAN_TYPE, { plan });
	}

	function notify(ctx: ExtensionContext | undefined, message: string): void {
		if (ctx?.hasUI) {
			ctx.ui.notify(message, "info");
		}
	}

	function setCurrentPlan(planId: string | null, options?: { persist?: boolean }): void {
		currentPlanId = planId;
		if (options?.persist !== false) {
			persistState();
		}
	}

	function applyMode(nextMode: SessionMode, ctx?: ExtensionContext, options?: { silent?: boolean }): void {
		const activeCtx = ctx ?? currentCtx;
		if (!activeCtx) return;
		if (nextMode === currentMode) {
			installUI(activeCtx);
			return;
		}

		if (nextMode === "default") {
			const toolsToRestore = sanitizeToolNames(restoreTools);
			if (toolsToRestore.length > 0) {
				pi.setActiveTools(toolsToRestore);
			}
			currentMode = "default";
			restoreTools = toolsToRestore.length > 0 ? toolsToRestore : sanitizeToolNames(getCurrentActiveTools());
		} else {
			if (currentMode === "default" || !restoreTools || restoreTools.length === 0) {
				const activeTools = sanitizeToolNames(getCurrentActiveTools());
				if (activeTools.length > 0) {
					restoreTools = activeTools;
				}
			}
			currentMode = nextMode;
			pi.setActiveTools(getRestrictedModeTools());
		}

		persistState();
		installUI(activeCtx);
		if (!options?.silent) {
			notify(activeCtx, `Session mode: ${currentMode}`);
		}
	}

	function syncStateFromSession(ctx: ExtensionContext): void {
		currentCtx = ctx;
		const previousRestoreTools = sanitizeToolNames(restoreTools);
		const entries = ctx.sessionManager.getBranch() as SessionEntryLike[];
		const snapshot = reconstructSessionModes(entries, getAvailableToolNames());
		currentMode = snapshot.state.mode;
		currentPlanId = snapshot.state.currentPlanId;
		restoreTools = snapshot.state.restoreTools;
		plansById = snapshot.plans;

		if ((!restoreTools || restoreTools.length === 0) && currentMode !== "default") {
			restoreTools = previousRestoreTools.length > 0 ? previousRestoreTools : sanitizeToolNames(getCurrentActiveTools());
		}

		if (currentMode === "default") {
			const toolsToRestore =
				sanitizeToolNames(restoreTools).length > 0 ? sanitizeToolNames(restoreTools) : previousRestoreTools;
			if (toolsToRestore.length > 0) {
				pi.setActiveTools(toolsToRestore);
			}
			restoreTools = toolsToRestore.length > 0 ? toolsToRestore : null;
		} else {
			pi.setActiveTools(getRestrictedModeTools());
		}

		installUI(ctx);
	}

	function renderPlanResult(details: SessionPlanToolDetails, theme: ExtensionContext["ui"]["theme"]): Text {
		if (details.action === "list") {
			if (details.plans.length === 0) {
				return new Text(theme.fg("warning", "No plans have been created for this session yet."), 0, 0);
			}
			const lines = details.plans.map((summary) => {
				const bullet = summary.isCurrent ? theme.fg("success", "● ") : theme.fg("dim", "○ ");
				const id = summary.isCurrent ? theme.fg("accent", summary.id) : summary.id;
				const title = summary.title ? theme.fg("muted", ` — ${summary.title}`) : "";
				const meta = theme.fg("dim", ` • ${summary.stepCount} step${summary.stepCount === 1 ? "" : "s"} • r${summary.revision}`);
				return `${bullet}${id}${title}${meta}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		}

		if (!details.plan) {
			return new Text(details.message ?? "No plan information available.", 0, 0);
		}

		const plan = details.plan;
		const lines: string[] = [];
		if (details.message) {
			lines.push(theme.fg("success", details.message));
			lines.push("");
		}
		lines.push(theme.fg("accent", theme.bold(`Plan ${plan.id}`)));
		if (plan.title) {
			lines.push(`${theme.fg("muted", "Title: ")}${plan.title}`);
		}
		if (plan.summary) {
			lines.push("");
			lines.push(plan.summary);
		}
		lines.push("");
		for (let index = 0; index < plan.steps.length; index += 1) {
			lines.push(`${theme.fg("muted", `${index + 1}. `)}${plan.steps[index]}`);
		}
		lines.push("");
		lines.push(theme.fg("dim", `Revision ${plan.revision} • Updated ${plan.updatedAt}`));
		return new Text(lines.join("\n"), 0, 0);
	}

	pi.registerTool({
		name: SESSION_PLAN_TOOL,
		label: "Session Plan",
		description: "Create, update, show, list, and select persisted session-linked plans.",
		promptSnippet: "Create, update, show, list, and select persisted session-linked plans",
		promptGuidelines: [
			"Use this tool whenever the user asks to create, update, show, list, or select a plan.",
			"If the user refers to 'the plan' without an id, treat it as the current plan if one exists.",
			"If the user refers to a specific plan id, pass that id and it becomes the current plan.",
			"Create and update are for full persisted plans with ordered steps and should be used in plan mode.",
		],
		parameters: SessionPlanParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const toolCtx = ctx as ExtensionContext;
			currentCtx = toolCtx;
			const action = params.action as SessionPlanAction;
			const explicitPlanId = trimToUndefined(params.planId);
			const steps = normalizeSteps(params.steps);
			const currentPlan = getCurrentPlan();
			const summaries = () => getPlanSummaries(plansById, currentPlanId);

			const fail = (message: string): { content: { type: "text"; text: string }[]; details: SessionPlanToolDetails } => ({
				content: [{ type: "text", text: message }],
				details: {
					action,
					changed: false,
					plan: null,
					currentPlanId,
					plans: summaries(),
					message,
				},
			});

			if ((action === "create" || action === "update") && currentMode !== "plan") {
				return fail("Plan creation and updates are only available while session mode is set to plan.");
			}

			if (action === "create") {
				if (steps.length === 0) {
					return fail("Creating a plan requires a non-empty ordered steps array.");
				}
				const planId = explicitPlanId ?? generateFriendlyPlanId(plansById.keys());
				if (plansById.has(planId)) {
					return fail(`Plan ${planId} already exists. Use update instead.`);
				}
				const plan = buildPlanRecord({
					id: planId,
					title: params.title,
					summary: params.summary,
					steps,
				});
				persistPlan(plan);
				setCurrentPlan(plan.id);
				return {
					content: [{ type: "text", text: buildPlanToolContent({ action, changed: true, plan, currentPlanId, plans: summaries(), message: `Created plan ${plan.id}.` }) }],
					details: {
						action,
						changed: true,
						plan,
						currentPlanId,
						plans: summaries(),
						message: `Created plan ${plan.id}.`,
					},
				};
			}

			if (action === "update") {
				if (steps.length === 0) {
					return fail("Updating a plan requires the full revised ordered steps array.");
				}
				const targetPlanId = explicitPlanId ?? currentPlanId;
				if (!targetPlanId) {
					return fail("There is no current plan to update.");
				}
				const existing = plansById.get(targetPlanId);
				if (!existing) {
					return fail(`Plan ${targetPlanId} does not exist.`);
				}
				const plan = updatePlanRecord(existing, {
					title: trimToUndefined(params.title) ?? existing.title,
					summary: trimToUndefined(params.summary) ?? existing.summary,
					steps,
				});
				persistPlan(plan);
				setCurrentPlan(plan.id);
				return {
					content: [{ type: "text", text: buildPlanToolContent({ action, changed: true, plan, currentPlanId, plans: summaries(), message: `Updated plan ${plan.id}.` }) }],
					details: {
						action,
						changed: true,
						plan,
						currentPlanId,
						plans: summaries(),
						message: `Updated plan ${plan.id}.`,
					},
				};
			}

			if (action === "list") {
				const details: SessionPlanToolDetails = {
					action,
					changed: false,
					plan: null,
					currentPlanId,
					plans: summaries(),
					message: plansById.size === 0 ? "No plans have been created for this session yet." : undefined,
				};
				return {
					content: [{ type: "text", text: buildPlanToolContent(details) }],
					details,
				};
			}

			if (action === "select") {
				if (!explicitPlanId) {
					return fail("Selecting a plan requires a specific plan id.");
				}
				const plan = plansById.get(explicitPlanId);
				if (!plan) {
					return fail(`Plan ${explicitPlanId} does not exist.`);
				}
				const selectionChanged = currentPlanId !== plan.id;
				setCurrentPlan(plan.id, { persist: selectionChanged });
				const details: SessionPlanToolDetails = {
					action,
					changed: selectionChanged,
					plan,
					currentPlanId,
					plans: summaries(),
					message: `Selected plan ${plan.id}.`,
				};
				return {
					content: [{ type: "text", text: buildPlanToolContent(details) }],
					details,
				};
			}

			const planIdToShow = explicitPlanId ?? currentPlan?.id ?? null;
			if (!planIdToShow) {
				return fail("There is no current plan to show.");
			}
			const plan = plansById.get(planIdToShow);
			if (!plan) {
				return fail(`Plan ${planIdToShow} does not exist.`);
			}
			const selectionChanged = !!explicitPlanId && currentPlanId !== plan.id;
			if (selectionChanged) {
				setCurrentPlan(plan.id);
			}
			const details: SessionPlanToolDetails = {
				action,
				changed: selectionChanged,
				plan,
				currentPlanId,
				plans: summaries(),
				message: `Showing plan ${plan.id}.`,
			};
			return {
				content: [{ type: "text", text: buildPlanToolContent(details) }],
				details,
			};
		},
		renderCall(args, theme) {
			const action = typeof args.action === "string" ? args.action : "show";
			const planId = typeof args.planId === "string" ? args.planId : undefined;
			let text = theme.fg("toolTitle", theme.bold(`${SESSION_PLAN_TOOL} `));
			text += theme.fg("muted", action);
			if (planId) {
				text += ` ${theme.fg("accent", planId)}`;
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as SessionPlanToolDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			return renderPlanResult(details, theme);
		},
	});

	pi.registerCommand(IMPLEMENT_PLAN_COMMAND, {
		description: "Internal session-modes handoff command.",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const plan = getCurrentPlan();
			if (!plan) {
				notify(ctx, "There is no current plan to implement.");
				return;
			}

			const action = (args ?? "").trim().toLowerCase();
			if (action !== "clean" && action !== "keep") {
				notify(ctx, `Usage: /${IMPLEMENT_PLAN_COMMAND} <clean|keep>`);
				return;
			}

			if (action === "keep") {
				applyMode("default", ctx, { silent: true });
				pi.sendUserMessage(buildImplementationPrompt(plan));
				return;
			}

			await ctx.waitForIdle();
			const currentSessionFile = ctx.sessionManager.getSessionFile();
			const result = await ctx.newSession({
				parentSession: currentSessionFile,
				setup: async (sessionManager) => {
					sessionManager.appendCustomEntry(SESSION_MODES_PLAN_TYPE, { plan });
					sessionManager.appendCustomEntry(SESSION_MODES_STATE_TYPE, {
						...createDefaultState(),
						currentPlanId: plan.id,
					});
				},
			});
			if (result.cancelled) return;
			pi.sendUserMessage(buildImplementationPrompt(plan));
		},
	});

	pi.on("input", async (event, ctx) => {
		currentCtx = ctx;
		if (event.source === "extension") {
			return { action: "continue" };
		}
		if (currentMode !== "plan" && isPlanMutationPrompt(event.text)) {
			applyMode("plan", ctx, { silent: true });
			notify(ctx, "Session mode: plan");
		}
		return { action: "continue" };
	});

	pi.on("tool_call", async (event) => {
		const planAction =
			event.toolName === SESSION_PLAN_TOOL && typeof (event.input as { action?: unknown }).action === "string"
				? ((event.input as { action: SessionPlanAction }).action as SessionPlanAction)
				: undefined;

		if (currentMode === "default") {
			if ((planAction === "create" || planAction === "update") && event.toolName === SESSION_PLAN_TOOL) {
				return {
					block: true,
					reason: "Plan creation and updates are only allowed in plan mode.",
				};
			}
			return;
		}

		const allowedTools = new Set(getRestrictedModeTools());
		if (!allowedTools.has(event.toolName)) {
			return {
				block: true,
				reason: `Session mode ${currentMode}: tool blocked (${event.toolName}). Allowed tools: ${[...allowedTools].join(", ")}`,
			};
		}

		if (event.toolName === SESSION_PLAN_TOOL && currentMode === "read-only" && (planAction === "create" || planAction === "update")) {
			return {
				block: true,
				reason: "Plan creation and updates are only allowed in plan mode.",
			};
		}

		if (event.toolName !== "bash") return;
		const command =
			typeof (event.input as { command?: unknown }).command === "string" ? (event.input as { command: string }).command : "";
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Session mode ${currentMode}: command blocked (not allowlisted).\nCommand: ${command}`,
			};
		}
	});

	pi.on("context", async (event) => ({
		messages: event.messages.filter((message) => (message as { customType?: string }).customType !== SESSION_MODES_CONTEXT_TYPE),
	}));

	pi.on("before_agent_start", async (event) => {
		const currentPlan = getCurrentPlan();
		const knownPlanIds = [...plansById.keys()].sort();
		const promptText = typeof event.prompt === "string" ? event.prompt : "";
		const promptMentionsPlan = /\bplans?\b/i.test(promptText) || knownPlanIds.some((planId) => promptText.includes(planId));
		if (currentMode === "default" && !promptMentionsPlan) {
			return;
		}
		const lines: string[] = [];

		if (currentMode !== "default" || currentPlan || knownPlanIds.length > 0) {
			lines.push("[SESSION MODES]");
			lines.push(`Current mode: ${currentMode}`);
			lines.push(`Current plan: ${currentPlan?.id ?? "none"}`);
			if (knownPlanIds.length > 0) {
				lines.push(`Known plan ids: ${knownPlanIds.join(", ")}`);
			}
			lines.push("");
			lines.push("Plan rules:");
			lines.push(`- Use ${SESSION_PLAN_TOOL} to create, update, show, list, and select persisted session-linked plans.`);
			lines.push("- If the user refers to 'the plan' without an id, use the current plan if one exists.");
			lines.push("- If the user refers to a specific plan id, use that id and treat it as the current plan.");
			lines.push("- Create and update should persist the full revised plan with ordered steps.");
		}

		if (currentPlan) {
			lines.push("");
			lines.push(formatPlanForContext(currentPlan));
		}

		if (currentMode === "read-only" || currentMode === "plan") {
			lines.push("");
			lines.push("Restrictions:");
			lines.push(`- You can only use: ${getRestrictedModeTools().join(", ")}`);
			lines.push("- Do not modify project files, dependencies, the environment, or git state.");
			lines.push(`- ${SESSION_PLAN_TOOL} is allowed for persisted session planning metadata only.`);
			lines.push("- Bash is restricted to an allowlist of read-only commands.");
		}

		if (currentMode === "plan") {
			lines.push("");
			lines.push("Plan mode guidance:");
			lines.push(`- Focus on creating or updating the session plan with ${SESSION_PLAN_TOOL}.`);
			lines.push("- When creating or modifying a plan, persist it before you finish your response.");
			lines.push("- You may answer plan-related questions without changing the plan.");
			lines.push("- Do not start implementation while plan mode is active.");
		}

		if (lines.length === 0) return;
		return {
			message: {
				customType: SESSION_MODES_CONTEXT_TYPE,
				content: lines.join("\n"),
				display: false,
			},
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		currentCtx = ctx;
		if (currentMode !== "plan" || !ctx.hasUI) return;
		const mutation = getPlanMutationFromMessages(event.messages);
		if (!mutation?.plan) return;

		const questionnaireResult = await runQuestionnaireUI(ctx, IMPLEMENT_PLAN_CHOICES);
		const choice = questionnaireResult.cancelled ? "stay" : questionnaireResult.answers[0]?.value ?? "stay";
		if (choice === "stay") return;
		if (choice === "keep" || choice === "clean") {
			pi.sendUserMessage(`/${IMPLEMENT_PLAN_COMMAND} ${choice}`);
		}
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
