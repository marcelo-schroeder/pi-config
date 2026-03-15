#!/usr/bin/env node

import process from "node:process";
import { parseArgs, getHelpText } from "../src/args.js";
import { maybeCleanupRunWorktree, promptRemovalConfirmation } from "../src/cleanup.js";
import {
	getCurrentBranch,
	getManagedWorktree,
	getManagedWorktreePath,
	getOrCreateManagedWorktree,
	getRepoContext,
	isDirtyWorktree,
	listManagedWorktrees,
	renameManagedWorktree,
	removeManagedWorktree,
} from "../src/git.js";
import { launchPiSession } from "../src/launch.js";
import { buildManagedWorktreeMetadata, planManagedWorktreeCreation, readManagedWorktreeMetadata, writeManagedWorktreeMetadata } from "../src/metadata.js";
import { generateFriendlyName, managedBranchName, normalizeName } from "../src/names.js";

function printDebug(enabled, message, details) {
	if (!enabled) return;
	if (details === undefined) {
		console.error(`[piw] ${message}`);
		return;
	}
	console.error(`[piw] ${message}`, details);
}

function printManagedWorktrees(worktrees, asJson) {
	if (asJson) {
		console.log(JSON.stringify(worktrees, null, 2));
		return;
	}

	if (worktrees.length === 0) {
		console.log("No managed worktrees found.");
		return;
	}

	for (const worktree of worktrees) {
		const prefix = worktree.isCurrent ? "*" : "-";
		const stale = worktree.exists ? "" : " [missing path]";
		console.log(`${prefix} ${worktree.name}${stale}`);
		console.log(`  path: ${worktree.path}`);
		console.log(`  branch: ${worktree.branch}`);
	}
}

async function handleList(options) {
	const repo = await getRepoContext(process.cwd());
	printDebug(options.debug, "repo root", repo.repoRoot);
	const worktrees = await listManagedWorktrees(repo.repoRoot, repo.currentWorktreeRoot);
	printManagedWorktrees(worktrees, options.json);
}

async function handlePath(options) {
	const repo = await getRepoContext(process.cwd());
	const name = normalizeName(options.name);
	const existing = await getManagedWorktree(repo.repoRoot, name);
	console.log(existing?.path ?? getManagedWorktreePath(repo.repoRoot, name));
}

async function handleRemove(options) {
	const repo = await getRepoContext(process.cwd());
	const name = normalizeName(options.name);
	const worktree = await getManagedWorktree(repo.repoRoot, name);
	if (!worktree) {
		throw new Error(`No managed worktree named '${name}' was found for this repository.`);
	}

	const dirty = await isDirtyWorktree(worktree.path);
	if (!options.yes) {
		const confirmed = await promptRemovalConfirmation({ ...worktree, repoRoot: repo.repoRoot }, { dirty });
		if (!confirmed) {
			console.log(`piw: kept worktree '${name}'.`);
			return;
		}
	}

	const removed = await removeManagedWorktree({ repoRoot: repo.repoRoot, name });
	console.log(`Removed worktree '${removed.name}'.`);
	console.log(`  path: ${removed.path}`);
	console.log(`  branch: ${removed.branch}`);
}

async function handleRename(options) {
	const repo = await getRepoContext(process.cwd());
	const oldName = normalizeName(options.oldName);
	const newName = normalizeName(options.newName);
	const renamed = await renameManagedWorktree({
		repoRoot: repo.repoRoot,
		oldName,
		newName,
		currentWorktreeRoot: repo.currentWorktreeRoot,
	});
	console.log(`Renamed worktree '${oldName}' to '${renamed.name}'.`);
	console.log(`  path: ${renamed.path}`);
	console.log(`  branch: ${renamed.branch}`);
}

async function loadSessionMetadata(sessionPath) {
	return await readManagedWorktreeMetadata(sessionPath);
}

async function persistNewWorktreeMetadata({ repoRoot, worktree, nameWasProvided, baseInput, targetBranch }) {
	const metadata = await buildManagedWorktreeMetadata({
		repoRoot,
		name: worktree.name,
		branch: worktree.branch,
		nameWasProvided,
		baseInput,
		targetBranch,
	});
	await writeManagedWorktreeMetadata(worktree.path, metadata);
	return metadata;
}

async function handleRun(options) {
	const originalCwd = process.cwd();
	const repo = await getRepoContext(originalCwd);
	printDebug(options.debug, "repo root", repo.repoRoot);
	printDebug(options.debug, "current worktree root", repo.currentWorktreeRoot);

	const existingWorktrees = await listManagedWorktrees(repo.repoRoot, repo.currentWorktreeRoot);
	const existingNames = new Set(existingWorktrees.map((worktree) => worktree.name));
	const nameWasProvided = Boolean(options.name);
	const name = nameWasProvided ? normalizeName(options.name) : generateFriendlyName(existingNames);
	const branch = managedBranchName(name);
	const reusableWorktree = existingWorktrees.find((worktree) => worktree.name === name && worktree.exists);
	let creationPlan = null;

	if (!reusableWorktree) {
		const requestedBaseInput = options.base || (await getCurrentBranch(repo.currentWorktreeRoot));
		if (!requestedBaseInput) {
			throw new Error("Unable to determine a base branch from a detached HEAD. Re-run with --base <branch>.");
		}

		creationPlan = await planManagedWorktreeCreation({
			repoRoot: repo.repoRoot,
			baseInput: requestedBaseInput,
			targetBranch: options.target,
			baseWasProvided: Boolean(options.base),
		});
	}

	printDebug(options.debug, "selected worktree name", name);
	printDebug(options.debug, "managed branch", branch);
	printDebug(options.debug, "requested base", creationPlan?.requestedBaseInput ?? "(reuse existing worktree)");
	printDebug(options.debug, "effective base", creationPlan?.effectiveBaseInput ?? "(reuse existing worktree)");
	printDebug(options.debug, "integration target", creationPlan?.integration.branch ? `${creationPlan.integration.remote}/${creationPlan.integration.branch}` : "(default or existing metadata)");
	printDebug(options.debug, "switched to target base", creationPlan?.switchedToTargetBase ?? false);

	const { created, worktree } = await getOrCreateManagedWorktree({
		repoRoot: repo.repoRoot,
		name,
		baseBranch: creationPlan?.effectiveBaseInput ?? branch,
	});

	let metadata = null;
	if (created) {
		if (!creationPlan) {
			throw new Error("Failed to determine creation metadata for the new worktree.");
		}

		try {
			metadata = await persistNewWorktreeMetadata({
				repoRoot: repo.repoRoot,
				worktree,
				nameWasProvided,
				baseInput: creationPlan.effectiveBaseInput,
				targetBranch: options.target,
			});
		} catch (error) {
			let cleanupError = null;
			try {
				await removeManagedWorktree({ repoRoot: repo.repoRoot, name });
			} catch (cleanupFailure) {
				cleanupError = cleanupFailure;
			}

			const cleanupSuffix = cleanupError instanceof Error ? `\nAdditionally failed to clean up the new worktree: ${cleanupError.message}` : "";
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`${message}${cleanupSuffix}`);
		}
	} else {
		metadata = await loadSessionMetadata(worktree.path);
	}

	const session = {
		...worktree,
		repoRoot: repo.repoRoot,
		originalCwd,
		nameWasProvided,
		metadata,
	};

	console.log(`${created ? "Created" : "Reusing"} worktree '${session.name}'.`);
	console.log(`  path: ${session.path}`);
	console.log(`  branch: ${session.branch}`);

	const exitCode = await launchPiSession({
		session,
		piArgs: options.piArgs,
		piBin: options.piBin,
		originalCwd,
	});

	const cleanup = await maybeCleanupRunWorktree(session, options);
	if (cleanup.action === "deleted") {
		console.log(`Deleted worktree '${session.name}'.`);
	} else if (cleanup.protection.kind === "dirty") {
		console.log(`Kept dirty worktree '${session.name}'.`);
	} else if (cleanup.protection.kind === "unintegrated") {
		console.log(`Kept worktree '${session.name}' with commits not merged into ${cleanup.protection.integrationDisplay}.`);
	} else if (cleanup.protection.kind === "unknown") {
		console.log(`Kept protected worktree '${session.name}'.`);
	}

	process.exit(exitCode);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(getHelpText());
		return;
	}

	switch (options.command) {
		case "list":
			await handleList(options);
			return;
		case "path":
			await handlePath(options);
			return;
		case "rm":
			await handleRemove(options);
			return;
		case "rename":
			await handleRename(options);
			return;
		default:
			await handleRun(options);
	}
}

main().catch((error) => {
	console.error(`piw: ${error.message}`);
	process.exit(1);
});
