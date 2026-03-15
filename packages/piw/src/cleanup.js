import readline from "node:readline/promises";
import { isDirtyWorktree, isHeadIntegratedInto, removeManagedWorktree, revisionExists } from "./git.js";

function canPrompt() {
	return Boolean(process.stdin.isTTY) || process.env.PIW_ALLOW_NON_TTY_PROMPT === "1";
}

function trimToNull(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function getIntegrationTarget(session) {
	const remote = trimToNull(session.metadata?.integration?.remote);
	const branch = trimToNull(session.metadata?.integration?.branch);
	if (!remote || !branch) {
		return null;
	}

	return {
		remote,
		branch,
		localRef: `refs/heads/${branch}`,
		localDisplay: branch,
		remoteRef: `refs/remotes/${remote}/${branch}`,
		remoteDisplay: `${remote}/${branch}`,
	};
}

function formatIntegrationTargetDisplay(target) {
	if (!target) {
		return "the recorded target branches";
	}

	const displays = [target.localDisplay, target.remoteDisplay].filter(Boolean);
	const uniqueDisplays = [...new Set(displays)];
	return uniqueDisplays.map((display) => `'${display}'`).join(" or ");
}

async function inspectWorktreeProtection(session) {
	const hasUncommittedChanges = await isDirtyWorktree(session.path);
	const target = getIntegrationTarget(session);
	let integrationStatus = "unknown";
	let unknownReason = target ? "missing-target-refs" : "missing-target-metadata";
	let localTargetExists = false;
	let remoteTargetExists = false;
	let integratedIntoLocalTarget = false;
	let integratedIntoRemoteTarget = false;

	if (target) {
		localTargetExists = await revisionExists(session.repoRoot, target.localRef);
		remoteTargetExists = await revisionExists(session.repoRoot, target.remoteRef);

		if (remoteTargetExists) {
			integratedIntoRemoteTarget = await isHeadIntegratedInto(session.path, target.remoteRef);
		}

		if (!integratedIntoRemoteTarget && localTargetExists) {
			integratedIntoLocalTarget = await isHeadIntegratedInto(session.path, target.localRef);
		}

		if (integratedIntoRemoteTarget) {
			integrationStatus = "integrated";
			unknownReason = null;
		} else if (integratedIntoLocalTarget) {
			integrationStatus = "integrated-local";
			unknownReason = null;
		} else if (localTargetExists || remoteTargetExists) {
			integrationStatus = "unintegrated";
			unknownReason = null;
		}
	}

	let kind = "clean";
	if (hasUncommittedChanges) {
		kind = "dirty";
	} else if (integrationStatus === "unintegrated") {
		kind = "unintegrated";
	} else if (integrationStatus === "unknown") {
		kind = "unknown";
	}

	return {
		kind,
		hasUncommittedChanges,
		integrationStatus,
		integrationTarget: target,
		integrationDisplay: formatIntegrationTargetDisplay(target),
		localTargetExists,
		remoteTargetExists,
		integratedIntoLocalTarget,
		integratedIntoRemoteTarget,
		unknownReason,
	};
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

function printProtectionDetails(protection) {
	if (protection.hasUncommittedChanges) {
		console.log("The worktree has uncommitted changes.");
	}

	if (protection.integrationStatus === "unintegrated") {
		console.log(`The worktree has commits not merged into ${protection.integrationDisplay}.`);
	}

	if (protection.integrationStatus === "unknown") {
		if (protection.integrationTarget) {
			console.log(`piw could not verify whether commits are merged into ${protection.integrationDisplay}.`);
		} else {
			console.log("piw could not verify whether commits are merged because the worktree integration target metadata is missing or incomplete.");
		}
	}
}

function getNonInteractiveKeepMessage(session, protection) {
	if (protection.kind === "dirty") {
		return `piw: keeping dirty worktree '${session.name}' (no interactive prompt available).`;
	}

	if (protection.kind === "unintegrated") {
		return `piw: keeping worktree '${session.name}' because it has commits not merged into ${protection.integrationDisplay} (no interactive prompt available).`;
	}

	return `piw: keeping protected worktree '${session.name}' (no interactive prompt available).`;
}

export async function promptProtectedAction(session, protection) {
	if (!canPrompt()) {
		console.log(getNonInteractiveKeepMessage(session, protection));
		return "keep";
	}

	console.log("");
	console.log(`This pi session was running in worktree '${session.name}'.`);
	console.log(`Path: ${session.path}`);
	console.log(`Branch: ${session.branch}`);
	printProtectionDetails(protection);
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

export async function promptRemovalConfirmation(session, protection = {}) {
	if (!canPrompt()) {
		throw new Error("Refusing to delete without confirmation in non-interactive mode. Use --yes to override.");
	}

	console.log(`About to remove managed worktree '${session.name}'.`);
	console.log(`Path: ${session.path}`);
	console.log(`Branch: ${session.branch}`);
	if (protection.hasUncommittedChanges || protection.dirty) {
		console.log("State: dirty (uncommitted changes will be lost)");
	}
	if (protection.integrationStatus === "unintegrated") {
		console.log(`State: has commits not merged into ${protection.integrationDisplay}`);
	}
	if (protection.integrationStatus === "unknown") {
		if (protection.integrationTarget) {
			console.log(`State: integration status unknown relative to ${protection.integrationDisplay}`);
		} else {
			console.log("State: integration status unknown (worktree metadata is missing or incomplete)");
		}
	}

	while (true) {
		const answer = (await askQuestion("Delete it? [y/N]: ")).toLowerCase();
		if (!answer || answer === "n" || answer === "no") return false;
		if (answer === "y" || answer === "yes") return true;
		console.log("Please enter 'y' or 'n'.");
	}
}

export async function maybeCleanupRunWorktree(session, options) {
	const protection = await inspectWorktreeProtection(session);

	if (protection.kind === "clean") {
		const shouldDeleteClean = options.deleteClean || (!options.keepClean && !session.nameWasProvided);
		if (shouldDeleteClean) {
			await removeManagedWorktree({ repoRoot: session.repoRoot, name: session.name });
			return { protection, action: "deleted" };
		}
		return { protection, action: "kept" };
	}

	if (options.keepDirty) {
		return { protection, action: "kept" };
	}

	if (options.deleteDirty) {
		if (!options.yes) {
			const confirmed = await promptRemovalConfirmation(session, protection);
			if (!confirmed) {
				return { protection, action: "kept" };
			}
		}
		await removeManagedWorktree({ repoRoot: session.repoRoot, name: session.name });
		return { protection, action: "deleted" };
	}

	const action = await promptProtectedAction(session, protection);
	if (action === "delete") {
		await removeManagedWorktree({ repoRoot: session.repoRoot, name: session.name });
		return { protection, action: "deleted" };
	}

	return { protection, action: action === "cancel" ? "cancelled" : "kept" };
}
