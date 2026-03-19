export type SessionMode = "default" | "read-only" | "plan";
export type SessionPlanAction = "create" | "update" | "show" | "list" | "select";

export interface PlanRecord {
	id: string;
	title?: string;
	summary?: string;
	steps: string[];
	createdAt: string;
	updatedAt: string;
	revision: number;
}

export interface SessionModesState {
	mode: SessionMode;
	currentPlanId: string | null;
	restoreTools: string[] | null;
}

export interface SessionModesSnapshot {
	state: SessionModesState;
	plans: Map<string, PlanRecord>;
	currentPlan: PlanRecord | null;
}

export interface SessionPlanSummary {
	id: string;
	title?: string;
	revision: number;
	updatedAt: string;
	isCurrent: boolean;
	stepCount: number;
}

export interface SessionPlanToolDetails {
	action: SessionPlanAction;
	changed: boolean;
	plan: PlanRecord | null;
	currentPlanId: string | null;
	plans: SessionPlanSummary[];
	message?: string;
}
