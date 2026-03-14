import readline from "node:readline/promises";
import { isDirtyWorktree, removeManagedWorktree } from "./git.js";

function canPrompt() {
	return Boolean(process.stdin.isTTY) || process.env.PIW_ALLOW_NON_TTY_PROMPT === "1";
}

async function askQuestion(prompt) {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	try {
		const answer = await rl.question(prompt);
		return answer.trim();
	} finally {
		rl.close();
	}
}

export async function promptDirtyAction(session) {
	if (!canPrompt()) {
		console.log(`piw: keeping dirty worktree '${session.name}' (no interactive prompt available).`);
		return "keep";
	}

	console.log("");
	console.log(`This pi session was running in worktree '${session.name}'.`);
	console.log(`Path: ${session.path}`);
	console.log(`Branch: ${session.branch}`);
	console.log("The worktree has uncommitted changes.");
	console.log("");
	console.log("[k] Keep");
	console.log("[d] Delete (remove worktree and managed branch)");
	console.log("[c] Cancel");

	while (true) {
		const answer = (await askQuestion("Choose [k/d/c] (default: k): ")).toLowerCase();
		if (!answer || answer === "k" || answer === "keep") return "keep";
		if (answer === "d" || answer === "delete") return "delete";
		if (answer === "c" || answer === "cancel") return "cancel";
		console.log("Please enter 'k', 'd', or 'c'.");
	}
}

export async function promptRemovalConfirmation(session, { dirty }) {
	if (!canPrompt()) {
		throw new Error("Refusing to delete without confirmation in non-interactive mode. Use --yes to override.");
	}

	console.log(`About to remove managed worktree '${session.name}'.`);
	console.log(`Path: ${session.path}`);
	console.log(`Branch: ${session.branch}`);
	if (dirty) {
		console.log("State: dirty (uncommitted changes will be lost)");
	}

	while (true) {
		const answer = (await askQuestion("Delete it? [y/N]: ")).toLowerCase();
		if (!answer || answer === "n" || answer === "no") return false;
		if (answer === "y" || answer === "yes") return true;
		console.log("Please enter 'y' or 'n'.");
	}
}

export async function maybeCleanupRunWorktree(session, options) {
	const dirty = await isDirtyWorktree(session.path);

	if (!dirty) {
		const shouldDeleteClean = options.deleteClean || (!options.keepClean && !session.nameWasProvided);
		if (shouldDeleteClean) {
			await removeManagedWorktree({ repoRoot: session.repoRoot, name: session.name });
			return { dirty: false, action: "deleted" };
		}
		return { dirty: false, action: "kept" };
	}

	if (options.keepDirty) {
		return { dirty: true, action: "kept" };
	}

	if (options.deleteDirty) {
		if (!options.yes) {
			const confirmed = await promptRemovalConfirmation(session, { dirty: true });
			if (!confirmed) {
				return { dirty: true, action: "kept" };
			}
		}
		await removeManagedWorktree({ repoRoot: session.repoRoot, name: session.name });
		return { dirty: true, action: "deleted" };
	}

	const action = await promptDirtyAction(session);
	if (action === "delete") {
		await removeManagedWorktree({ repoRoot: session.repoRoot, name: session.name });
		return { dirty: true, action: "deleted" };
	}

	return { dirty: true, action: action === "cancel" ? "cancelled" : "kept" };
}
