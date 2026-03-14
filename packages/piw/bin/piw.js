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
	removeManagedWorktree,
} from "../src/git.js";
import { launchPiSession } from "../src/launch.js";
import { generateFriendlyName, normalizeName } from "../src/names.js";

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

async function handleRun(options) {
	const originalCwd = process.cwd();
	const repo = await getRepoContext(originalCwd);
	printDebug(options.debug, "repo root", repo.repoRoot);
	printDebug(options.debug, "current worktree root", repo.currentWorktreeRoot);

	const existingWorktrees = await listManagedWorktrees(repo.repoRoot, repo.currentWorktreeRoot);
	const existingNames = new Set(existingWorktrees.map((worktree) => worktree.name));
	const nameWasProvided = Boolean(options.name);
	const name = nameWasProvided ? normalizeName(options.name) : generateFriendlyName(existingNames);
	const baseBranch = options.base || (await getCurrentBranch(repo.currentWorktreeRoot));

	if (!baseBranch) {
		throw new Error("Unable to determine a base branch from a detached HEAD. Re-run with --base <branch>.");
	}

	printDebug(options.debug, "selected worktree name", name);
	printDebug(options.debug, "base branch", baseBranch);

	const { created, worktree } = await getOrCreateManagedWorktree({
		repoRoot: repo.repoRoot,
		name,
		baseBranch,
	});

	const session = {
		...worktree,
		repoRoot: repo.repoRoot,
		originalCwd,
		nameWasProvided,
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
	} else if (cleanup.dirty) {
		console.log(`Kept dirty worktree '${session.name}'.`);
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
		default:
			await handleRun(options);
	}
}

main().catch((error) => {
	console.error(`piw: ${error.message}`);
	process.exit(1);
});
