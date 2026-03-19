import type { PlanRecord, SessionModesSnapshot, SessionModesState, SessionPlanSummary } from "./types.ts";

export const SESSION_MODES_STATE_TYPE = "session-modes-state";
export const SESSION_MODES_PLAN_TYPE = "session-modes-plan";

interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

interface PersistedPlanEntry {
	plan?: PlanRecord;
}

const VALID_MODES = new Set(["default", "read-only", "plan"] as const);

function trimToUndefined(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePlanStep(step: unknown): string | null {
	if (typeof step !== "string") return null;
	const normalized = step
		.replace(/^\s*(?:[-*+]|(\d+)[.)])\s+/, "")
		.replace(/\s+/g, " ")
		.trim();
	return normalized.length > 0 ? normalized : null;
}

function normalizePlanRecord(value: unknown): PlanRecord | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Partial<PlanRecord>;
	const id = trimToUndefined(candidate.id);
	const steps = Array.isArray(candidate.steps)
		? candidate.steps.map((step) => normalizePlanStep(step)).filter((step): step is string => step !== null)
		: [];
	if (!id || steps.length === 0) return null;
	const createdAt = trimToUndefined(candidate.createdAt) ?? new Date().toISOString();
	const updatedAt = trimToUndefined(candidate.updatedAt) ?? createdAt;
	const revision = Number.isInteger(candidate.revision) && (candidate.revision ?? 0) > 0 ? (candidate.revision as number) : 1;
	return {
		id,
		title: trimToUndefined(candidate.title),
		summary: trimToUndefined(candidate.summary),
		steps,
		createdAt,
		updatedAt,
		revision,
	};
}

function normalizePersistedState(
	value: unknown,
	availableToolNames?: Set<string>,
): SessionModesState {
	const candidate = value && typeof value === "object" ? (value as Partial<SessionModesState>) : {};
	const mode = VALID_MODES.has(candidate.mode as SessionModesState["mode"]) ? (candidate.mode as SessionModesState["mode"]) : "default";
	const currentPlanId = trimToUndefined(candidate.currentPlanId) ?? null;
	const restoreTools = Array.isArray(candidate.restoreTools)
		? candidate.restoreTools
				.filter((toolName): toolName is string => typeof toolName === "string")
				.filter((toolName, index, tools) => tools.indexOf(toolName) === index)
				.filter((toolName) => !availableToolNames || availableToolNames.size === 0 || availableToolNames.has(toolName))
		: null;
	return {
		mode,
		currentPlanId,
		restoreTools: restoreTools && restoreTools.length > 0 ? restoreTools : null,
	};
}

export function createDefaultState(): SessionModesState {
	return {
		mode: "default",
		currentPlanId: null,
		restoreTools: null,
	};
}

export function reconstructSessionModes(
	entries: SessionEntryLike[],
	availableToolNames?: Set<string>,
): SessionModesSnapshot {
	const plans = new Map<string, PlanRecord>();
	let state = createDefaultState();

	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === SESSION_MODES_PLAN_TYPE) {
			const persisted = entry.data as PersistedPlanEntry | undefined;
			const plan = normalizePlanRecord(persisted?.plan);
			if (plan) {
				plans.set(plan.id, plan);
			}
		}
		if (entry.customType === SESSION_MODES_STATE_TYPE) {
			state = normalizePersistedState(entry.data, availableToolNames);
		}
	}

	const currentPlan = state.currentPlanId ? plans.get(state.currentPlanId) ?? null : null;
	if (!currentPlan && state.currentPlanId) {
		state = { ...state, currentPlanId: null };
	}

	return {
		state,
		plans,
		currentPlan: state.currentPlanId ? plans.get(state.currentPlanId) ?? null : null,
	};
}

export function buildPlanRecord(
	plan: Pick<PlanRecord, "id" | "steps"> & Partial<Omit<PlanRecord, "id" | "steps">>,
	now = new Date().toISOString(),
): PlanRecord {
	const steps = plan.steps.map((step) => normalizePlanStep(step)).filter((step): step is string => step !== null);
	if (steps.length === 0) {
		throw new Error("Plans must contain at least one step.");
	}
	return {
		id: plan.id,
		title: trimToUndefined(plan.title),
		summary: trimToUndefined(plan.summary),
		steps,
		createdAt: trimToUndefined(plan.createdAt) ?? now,
		updatedAt: trimToUndefined(plan.updatedAt) ?? now,
		revision: Number.isInteger(plan.revision) && (plan.revision ?? 0) > 0 ? (plan.revision as number) : 1,
	};
}

export function updatePlanRecord(
	existing: PlanRecord,
	updates: Pick<PlanRecord, "steps"> & Partial<Omit<PlanRecord, "id" | "steps">>,
	now = new Date().toISOString(),
): PlanRecord {
	return buildPlanRecord(
		{
			...existing,
			...updates,
			id: existing.id,
			createdAt: existing.createdAt,
			updatedAt: now,
			revision: existing.revision + 1,
		},
		now,
	);
}

export function summarizePlans(plans: Iterable<PlanRecord>, currentPlanId: string | null): SessionPlanSummary[] {
	return [...plans]
		.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
		.reverse()
		.map((plan) => ({
			id: plan.id,
			title: plan.title,
			revision: plan.revision,
			updatedAt: plan.updatedAt,
			isCurrent: plan.id === currentPlanId,
			stepCount: plan.steps.length,
		}));
}

export function formatPlanForDisplay(plan: PlanRecord): string {
	const lines: string[] = [];
	lines.push(`Plan ${plan.id}`);
	if (plan.title) lines.push(`Title: ${plan.title}`);
	if (plan.summary) {
		lines.push("");
		lines.push(plan.summary);
	}
	lines.push("");
	for (let index = 0; index < plan.steps.length; index += 1) {
		lines.push(`${index + 1}. ${plan.steps[index]}`);
	}
	lines.push("");
	lines.push(`Revision ${plan.revision} • Updated ${plan.updatedAt}`);
	return lines.join("\n");
}

export function formatPlanForContext(plan: PlanRecord): string {
	const lines: string[] = [`Current plan: ${plan.id}`];
	if (plan.title) lines.push(`Title: ${plan.title}`);
	if (plan.summary) lines.push(`Summary: ${plan.summary}`);
	lines.push("Steps:");
	for (let index = 0; index < plan.steps.length; index += 1) {
		lines.push(`${index + 1}. ${plan.steps[index]}`);
	}
	return lines.join("\n");
}

export function formatPlanList(summaries: SessionPlanSummary[]): string {
	if (summaries.length === 0) {
		return "No plans have been created for this session yet.";
	}
	return summaries
		.map((summary) => {
			const current = summary.isCurrent ? " (current)" : "";
			const title = summary.title ? ` — ${summary.title}` : "";
			return `${summary.id}${current}${title} • ${summary.stepCount} step${summary.stepCount === 1 ? "" : "s"} • r${summary.revision}`;
		})
		.join("\n");
}

export function isPlanMutationAction(action: string): boolean {
	return action === "create" || action === "update";
}
