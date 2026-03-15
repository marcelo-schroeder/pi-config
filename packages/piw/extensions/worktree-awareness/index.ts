import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildWorktreeSessionFromEnv } from "../../src/session-env.js";

interface WorktreeBaseInfo {
	input: string | null;
	resolvedRef: string | null;
	commit: string | null;
}

interface WorktreeIntegrationInfo {
	remote: string | null;
	branch: string | null;
	targetCommitAtCreation: string | null;
	createdFromTarget: boolean | null;
}

interface WorktreeSessionInfo {
	active: true;
	kind: "piw";
	managed: true;
	name: string;
	path: string;
	branch: string;
	repoRoot: string;
	originalCwd: string;
	nameWasProvided: boolean | null;
	metadataComplete: boolean;
	base: WorktreeBaseInfo | null;
	integration: WorktreeIntegrationInfo | null;
}

function getSessionInfo(): WorktreeSessionInfo | null {
	const session = buildWorktreeSessionFromEnv(process.env);
	return session as WorktreeSessionInfo | null;
}

export default function worktreeAwareness(pi: ExtensionAPI): void {
	const session = getSessionInfo();
	if (!session) {
		return;
	}

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n## Worktree Session\nThis session is running inside a wrapper-managed git worktree.\n\nActive worktree details:\n- name: ${session.name}\n- branch: ${session.branch}\n- path: ${session.path}\n- primary checkout: ${session.repoRoot}\n- original launch directory: ${session.originalCwd}\n- metadata complete: ${session.metadataComplete ? "yes" : "no"}\n\nRules:\n- Use the worktree_info tool as the authoritative source for this session's worktree metadata.\n- Do not infer worktree state from filesystem layout or git upstream tracking when worktree_info is available.\n- Treat the current worktree as the only editable checkout unless the user explicitly says otherwise.\n- Do not delete this worktree, its branch, or any sibling worktrees unless the user explicitly asks.\n- Do not assume changes should be mirrored back into the primary checkout.\n- Mention the active worktree name and branch in plans and completion summaries when relevant.`,
		};
	});

	pi.registerTool({
		name: "worktree_info",
		label: "Worktree Info",
		description: "Inspect the current wrapper-managed worktree session.",
		promptSnippet: "Read the active wrapper-managed worktree metadata.",
		promptGuidelines: ["Use this tool when you need to confirm the current worktree name, branch, path, or integration metadata."],
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: JSON.stringify(session, null, 2) }],
				details: session,
			};
		},
	});
}
