import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface WorktreeSessionInfo {
	active: true;
	name: string;
	path: string;
	branch: string;
	repoRoot: string;
	originalCwd: string;
}

function getSessionInfo(): WorktreeSessionInfo | null {
	if (process.env.PI_WORKTREE_SESSION !== "1") {
		return null;
	}

	const name = process.env.PI_WORKTREE_NAME;
	const worktreePath = process.env.PI_WORKTREE_PATH;
	const branch = process.env.PI_WORKTREE_BRANCH;
	const repoRoot = process.env.PI_WORKTREE_REPO_ROOT;
	const originalCwd = process.env.PI_WORKTREE_ORIGINAL_CWD || process.cwd();

	if (!name || !worktreePath || !branch || !repoRoot) {
		return null;
	}

	return {
		active: true,
		name,
		path: worktreePath,
		branch,
		repoRoot,
		originalCwd,
	};
}

export default function worktreeAwareness(pi: ExtensionAPI): void {
	const session = getSessionInfo();
	if (!session) {
		return;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("piw-worktree", ctx.ui.theme.fg("accent", `wt ${session.name} (${session.branch})`));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("piw-worktree", undefined);
	});

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n## Worktree Session\nThis session is running inside a wrapper-managed git worktree.\n\nActive worktree details:\n- name: ${session.name}\n- branch: ${session.branch}\n- path: ${session.path}\n- primary checkout: ${session.repoRoot}\n- original launch directory: ${session.originalCwd}\n\nRules:\n- Treat the current worktree as the only editable checkout unless the user explicitly says otherwise.\n- Do not delete this worktree, its branch, or any sibling worktrees unless the user explicitly asks.\n- Do not assume changes should be mirrored back into the primary checkout.\n- Mention the active worktree name and branch in plans and completion summaries when relevant.`,
		};
	});

	pi.registerTool({
		name: "worktree_info",
		label: "Worktree Info",
		description: "Inspect the current wrapper-managed worktree session.",
		promptSnippet: "Read the active wrapper-managed worktree metadata.",
		promptGuidelines: ["Use this tool when you need to confirm the current worktree name, branch, or path."],
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: JSON.stringify(session, null, 2) }],
				details: session,
			};
		},
	});
}
