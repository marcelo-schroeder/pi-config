import { stat } from "node:fs/promises";

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

const COMMAND_NAME = "my-new-cmux-tab";
const COMMAND_USAGE = `Usage: /${COMMAND_NAME}`;
const NEW_TAB_SHELL_READY_DELAY_MS = 250;

interface CmuxPaneSnapshot {
	ref: string;
	surfaceRefs: string[];
}

interface CmuxTreeSnapshot {
	activeWorkspaceRef: string | null;
	activePaneRef: string | null;
	activeSurfaceRef: string | null;
	panes: CmuxPaneSnapshot[];
}

interface CmuxExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

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

function shellEscape(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}` + `'`;
}

function parseTreeSnapshot(stdout: string): CmuxTreeSnapshot {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		throw new Error(`Failed to parse cmux tree output as JSON: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!isRecord(parsed)) {
		throw new Error("Failed to parse cmux tree output: expected a JSON object.");
	}

	const active = isRecord(parsed.active) ? parsed.active : {};
	const windowsRaw = Array.isArray(parsed.windows) ? parsed.windows : [];
	const panes: CmuxPaneSnapshot[] = [];

	for (const windowValue of windowsRaw) {
		if (!isRecord(windowValue)) continue;
		const workspacesRaw = Array.isArray(windowValue.workspaces) ? windowValue.workspaces : [];

		for (const workspaceValue of workspacesRaw) {
			if (!isRecord(workspaceValue)) continue;
			const panesRaw = Array.isArray(workspaceValue.panes) ? workspaceValue.panes : [];

			for (const paneValue of panesRaw) {
				if (!isRecord(paneValue) || typeof paneValue.ref !== "string") continue;
				const surfaceRefs = Array.isArray(paneValue.surface_refs)
					? paneValue.surface_refs.filter((value): value is string => typeof value === "string")
					: [];
				panes.push({
					ref: paneValue.ref,
					surfaceRefs,
				});
			}
		}
	}

	return {
		activeWorkspaceRef: typeof active.workspace_ref === "string" ? active.workspace_ref : null,
		activePaneRef: typeof active.pane_ref === "string" ? active.pane_ref : null,
		activeSurfaceRef: typeof active.surface_ref === "string" ? active.surface_ref : null,
		panes,
	};
}

function formatExecFailure(action: string, result: CmuxExecResult): string {
	const stderr = result.stderr.trim();
	const stdout = result.stdout.trim();
	const detail = stderr || stdout || `${action} failed with exit code ${result.code}`;
	return `${action} failed: ${detail}`;
}

async function runCmux(pi: ExtensionAPI, args: string[], action: string): Promise<string> {
	let result: CmuxExecResult;
	try {
		result = (await pi.exec("cmux", args)) as CmuxExecResult;
	} catch (error) {
		throw new Error(`${action} failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (result.code !== 0) {
		throw new Error(formatExecFailure(action, result));
	}

	return result.stdout.trim();
}

async function readTreeSnapshot(pi: ExtensionAPI): Promise<CmuxTreeSnapshot> {
	const stdout = await runCmux(pi, ["tree", "--all", "--json"], "Reading cmux tab tree");
	return parseTreeSnapshot(stdout);
}

function getPane(snapshot: CmuxTreeSnapshot, paneRef: string | null): CmuxPaneSnapshot | null {
	if (!paneRef) return null;
	return snapshot.panes.find((pane) => pane.ref === paneRef) ?? null;
}

function getSurfaceRefs(snapshot: CmuxTreeSnapshot, paneRef: string | null): Set<string> {
	const pane = getPane(snapshot, paneRef);
	return new Set(pane?.surfaceRefs ?? []);
}

function getAllSurfaceRefs(snapshot: CmuxTreeSnapshot): Set<string> {
	return new Set(snapshot.panes.flatMap((pane) => pane.surfaceRefs));
}

function detectNewSurfaceRef(before: CmuxTreeSnapshot, after: CmuxTreeSnapshot): string | null {
	const beforePaneRefs = getSurfaceRefs(before, before.activePaneRef);
	const afterPaneRefs = getSurfaceRefs(after, before.activePaneRef);
	const paneDiff = [...afterPaneRefs].filter((ref) => !beforePaneRefs.has(ref));
	if (paneDiff.length === 1) {
		return paneDiff[0];
	}

	if (after.activePaneRef === before.activePaneRef && after.activeSurfaceRef && !beforePaneRefs.has(after.activeSurfaceRef)) {
		return after.activeSurfaceRef;
	}

	const beforeAllRefs = getAllSurfaceRefs(before);
	const afterAllRefs = getAllSurfaceRefs(after);
	const allDiff = [...afterAllRefs].filter((ref) => !beforeAllRefs.has(ref));
	if (allDiff.length === 1) {
		return allDiff[0];
	}

	return null;
}

function validateInvocation(args: string, ctx: ExtensionCommandContext): boolean {
	const trimmed = args.trim();
	if (!trimmed) return true;

	if (trimmed === "help" || trimmed === "--help" || trimmed === "-h") {
		notify(ctx, COMMAND_USAGE, "info");
		return false;
	}

	throw new Error(`/${COMMAND_NAME} does not accept arguments. ${COMMAND_USAGE}`);
}

async function resolveTargetCwd(): Promise<string | undefined> {
	if (process.env.PI_WORKTREE_SESSION !== "1") {
		return undefined;
	}

	const worktreePath = process.env.PI_WORKTREE_PATH?.trim();
	if (!worktreePath) {
		throw new Error("This looks like a piw worktree session, but PI_WORKTREE_PATH is missing.");
	}

	let stats;
	try {
		stats = await stat(worktreePath);
	} catch {
		throw new Error(`The piw worktree path does not exist: ${worktreePath}`);
	}

	if (!stats.isDirectory()) {
		throw new Error(`The piw worktree path is not a directory: ${worktreePath}`);
	}

	return worktreePath;
}

async function waitForShellReady(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, NEW_TAB_SHELL_READY_DELAY_MS));
}

async function changeDirectoryInSurface(pi: ExtensionAPI, workspaceRef: string, surfaceRef: string, targetCwd: string): Promise<void> {
	await waitForShellReady();
	const command = `cd -- ${shellEscape(targetCwd)}`;
	await runCmux(pi, ["send", "--workspace", workspaceRef, "--surface", surfaceRef, command], "Sending directory change to new cmux tab");
	await runCmux(pi, ["send-key", "--workspace", workspaceRef, "--surface", surfaceRef, "Enter"], "Executing directory change in new cmux tab");
}

async function createSiblingTab(pi: ExtensionAPI, targetCwd: string | undefined): Promise<{ newSurfaceRef: string; usedCwd: string | undefined }> {
	const before = await readTreeSnapshot(pi);
	if (!before.activeWorkspaceRef || !before.activePaneRef || !before.activeSurfaceRef) {
		throw new Error("Could not determine the active cmux tab.");
	}

	await runCmux(
		pi,
		[
			"tab-action",
			"--action",
			"new-terminal-right",
			"--surface",
			before.activeSurfaceRef,
			"--workspace",
			before.activeWorkspaceRef,
		],
		"Creating new cmux tab",
	);

	const after = await readTreeSnapshot(pi);
	const newSurfaceRef = detectNewSurfaceRef(before, after);
	if (!newSurfaceRef) {
		throw new Error("Created a new cmux tab, but could not determine which tab was created.");
	}

	if (targetCwd) {
		await changeDirectoryInSurface(pi, before.activeWorkspaceRef, newSurfaceRef, targetCwd);
	}

	return { newSurfaceRef, usedCwd: targetCwd };
}

export default function myNewCmuxTab(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Open a new sibling cmux tab; use the active piw worktree root when applicable.",
		handler: async (args, ctx) => {
			if (!validateInvocation(args, ctx)) {
				return;
			}

			if (!process.env.CMUX_WORKSPACE_ID || !process.env.CMUX_SURFACE_ID) {
				throw new Error(`/${COMMAND_NAME} requires running pi inside cmux so it can open the new tab next to the active tab.`);
			}

			await runCmux(pi, ["ping"], "Checking cmux availability");
			const targetCwd = await resolveTargetCwd();
			const result = await createSiblingTab(pi, targetCwd);

			if (result.usedCwd) {
				notify(ctx, `Opened a new sibling cmux tab and changed it to ${result.usedCwd}.`, "info");
				return;
			}

			notify(ctx, "Opened a new sibling cmux tab.", "info");
		},
	});
}
