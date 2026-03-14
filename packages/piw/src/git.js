import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getManagedNameFromBranch, isManagedBranchName, managedBranchName } from "./names.js";

const execFileAsync = promisify(execFile);

async function runGit(args, cwd) {
	try {
		const { stdout = "", stderr = "" } = await execFileAsync("git", args, {
			cwd,
			maxBuffer: 10 * 1024 * 1024,
		});
		return { code: 0, stdout, stderr };
	} catch (error) {
		if (error?.code === "ENOENT") {
			throw new Error("git is not installed or not available on PATH.");
		}

		return {
			code: typeof error?.code === "number" ? error.code : 1,
			stdout: error?.stdout ?? "",
			stderr: error?.stderr ?? error?.message ?? "",
		};
	}
}

async function runGitChecked(args, cwd, description) {
	const result = await runGit(args, cwd);
	if (result.code === 0) {
		return result;
	}

	const details = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
	throw new Error(details ? `${description}\n${details}` : description);
}

function resolveFromCwd(cwd, value) {
	if (!value) return null;
	return path.resolve(cwd, value);
}

async function pathExists(targetPath) {
	try {
		await fs.access(targetPath);
		return true;
	} catch {
		return false;
	}
}

function samePath(a, b) {
	return path.resolve(a) === path.resolve(b);
}

function isInsidePath(child, parent) {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseWorktreeList(output) {
	const entries = [];
	const lines = output.split(/\r?\n/);
	let current = null;

	for (const line of lines) {
		if (!line) {
			if (current?.path) {
				entries.push(current);
			}
			current = null;
			continue;
		}

		const separatorIndex = line.indexOf(" ");
		const key = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
		const value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);

		if (key === "worktree") {
			if (current?.path) {
				entries.push(current);
			}
			current = {
				path: path.resolve(value),
				head: null,
				branchRef: null,
				branchName: null,
				bare: false,
				detached: false,
				locked: false,
				prunable: false,
			};
			continue;
		}

		if (!current) {
			continue;
		}

		switch (key) {
			case "HEAD":
				current.head = value;
				break;
			case "branch":
				current.branchRef = value;
				current.branchName = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
				break;
			case "bare":
				current.bare = true;
				break;
			case "detached":
				current.detached = true;
				break;
			case "locked":
				current.locked = true;
				break;
			case "prunable":
				current.prunable = true;
				break;
			default:
				break;
		}
	}

	if (current?.path) {
		entries.push(current);
	}

	return entries;
}

async function listWorktreeEntries(gitCwd) {
	const result = await runGitChecked(["worktree", "list", "--porcelain"], gitCwd, "Failed to list git worktrees.");
	return parseWorktreeList(result.stdout);
}

async function detectMainWorktreePath(worktrees, commonGitDir, fallbackPath) {
	for (const entry of worktrees) {
		const dotGitPath = path.join(entry.path, ".git");
		try {
			const stats = await fs.lstat(dotGitPath);
			if (!stats.isDirectory()) {
				continue;
			}
			const resolvedGitDir = await fs.realpath(dotGitPath);
			if (samePath(resolvedGitDir, commonGitDir)) {
				return entry.path;
			}
		} catch {
			// Ignore inaccessible or missing worktrees while detecting the main checkout.
		}
	}

	if (worktrees.length > 0) {
		return worktrees[0].path;
	}

	return fallbackPath;
}

export async function getRepoContext(cwd) {
	const topLevel = await runGitChecked(["rev-parse", "--show-toplevel"], cwd, "Current directory is not inside a git repository.");
	const commonDir = await runGitChecked(["rev-parse", "--git-common-dir"], cwd, "Failed to locate the git common directory.");

	const currentWorktreeRoot = resolveFromCwd(cwd, topLevel.stdout.trim());
	const commonGitDir = resolveFromCwd(cwd, commonDir.stdout.trim());
	const worktrees = await listWorktreeEntries(currentWorktreeRoot);
	const repoRoot = await detectMainWorktreePath(worktrees, commonGitDir, currentWorktreeRoot);

	return {
		repoRoot,
		currentWorktreeRoot,
		commonGitDir,
		worktrees,
		isInsideManagedWorktree: !samePath(repoRoot, currentWorktreeRoot),
		isPathInsideManagedWorktree(targetPath) {
			return isInsidePath(targetPath, currentWorktreeRoot);
		},
	};
}

export function getManagedBaseDir(repoRoot) {
	return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}.worktrees`);
}

export function getManagedWorktreePath(repoRoot, name) {
	return path.join(getManagedBaseDir(repoRoot), name);
}

export function isManagedWorktreeEntry(repoRoot, entry) {
	if (!isManagedBranchName(entry.branchName)) {
		return false;
	}

	const managedName = getManagedNameFromBranch(entry.branchName);
	return managedName !== null && samePath(entry.path, getManagedWorktreePath(repoRoot, managedName));
}

function toManagedWorktree(repoRoot, entry, currentWorktreeRoot = null) {
	const name = getManagedNameFromBranch(entry.branchName);
	return {
		name,
		path: entry.path,
		branch: entry.branchName,
		isCurrent: currentWorktreeRoot ? samePath(currentWorktreeRoot, entry.path) : false,
		isMain: samePath(repoRoot, entry.path),
	};
}

export async function listManagedWorktrees(repoRoot, currentWorktreeRoot = null) {
	const entries = await listWorktreeEntries(repoRoot);
	const managed = entries
		.filter((entry) => isManagedWorktreeEntry(repoRoot, entry))
		.map((entry) => toManagedWorktree(repoRoot, entry, currentWorktreeRoot));

	const results = [];
	for (const item of managed.sort((left, right) => left.name.localeCompare(right.name))) {
		results.push({
			...item,
			exists: await pathExists(item.path),
		});
	}
	return results;
}

export async function getManagedWorktree(repoRoot, name) {
	const entries = await listWorktreeEntries(repoRoot);
	const branch = managedBranchName(name);
	const worktreePath = getManagedWorktreePath(repoRoot, name);
	const entry = entries.find((candidate) => candidate.branchName === branch && samePath(candidate.path, worktreePath));
	return entry ? toManagedWorktree(repoRoot, entry) : null;
}

export async function pruneWorktrees(repoRoot) {
	await runGitChecked(["worktree", "prune"], repoRoot, "Failed to prune stale git worktree metadata.");
}

export async function revisionExists(repoRoot, revision) {
	const result = await runGit(["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], repoRoot);
	return result.code === 0;
}

export async function getCurrentBranch(cwd) {
	const result = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
	if (result.code !== 0) {
		return null;
	}
	const branch = result.stdout.trim();
	return branch || null;
}

export async function branchExists(repoRoot, branchName) {
	const result = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repoRoot);
	return result.code === 0;
}

export async function getOrCreateManagedWorktree({ repoRoot, name, baseBranch }) {
	let managed = await getManagedWorktree(repoRoot, name);
	if (managed && !(await pathExists(managed.path))) {
		await pruneWorktrees(repoRoot);
		managed = await getManagedWorktree(repoRoot, name);
	}

	if (managed) {
		return { created: false, worktree: managed };
	}

	const branch = managedBranchName(name);
	const worktreePath = getManagedWorktreePath(repoRoot, name);
	let entries = await listWorktreeEntries(repoRoot);
	let branchEntry = entries.find((entry) => entry.branchName === branch);

	if (branchEntry && !(await pathExists(branchEntry.path))) {
		await pruneWorktrees(repoRoot);
		entries = await listWorktreeEntries(repoRoot);
		branchEntry = entries.find((entry) => entry.branchName === branch);
	}

	if (branchEntry && !samePath(branchEntry.path, worktreePath)) {
		throw new Error(`Managed branch '${branch}' is already checked out at '${branchEntry.path}'.`);
	}

	if (await pathExists(worktreePath)) {
		throw new Error(`Refusing to reuse existing path '${worktreePath}' because it is not a registered managed worktree.`);
	}

	if (!(await revisionExists(repoRoot, baseBranch))) {
		throw new Error(`Base branch or revision '${baseBranch}' does not exist.`);
	}

	await fs.mkdir(path.dirname(worktreePath), { recursive: true });

	if (await branchExists(repoRoot, branch)) {
		await runGitChecked(["worktree", "add", worktreePath, branch], repoRoot, `Failed to attach existing branch '${branch}' to a worktree.`);
	} else {
		await runGitChecked(
			["worktree", "add", "-b", branch, worktreePath, baseBranch],
			repoRoot,
			`Failed to create worktree '${name}' from '${baseBranch}'.`,
		);
	}

	managed = await getManagedWorktree(repoRoot, name);
	if (!managed) {
		throw new Error(`Worktree '${name}' was created, but could not be rediscovered afterward.`);
	}

	return { created: true, worktree: managed };
}

export async function isDirtyWorktree(worktreePath) {
	const result = await runGitChecked(["status", "--porcelain"], worktreePath, `Failed to inspect worktree status at '${worktreePath}'.`);
	return result.stdout.trim().length > 0;
}

export async function removeManagedWorktree({ repoRoot, name }) {
	let managed = await getManagedWorktree(repoRoot, name);
	if (managed && !(await pathExists(managed.path))) {
		await pruneWorktrees(repoRoot);
		managed = await getManagedWorktree(repoRoot, name);
	}

	if (!managed) {
		throw new Error(`No managed worktree named '${name}' was found for this repository.`);
	}

	if (managed.isMain || samePath(managed.path, repoRoot)) {
		throw new Error("Refusing to delete the main checkout.");
	}

	if (isInsidePath(process.cwd(), managed.path)) {
		process.chdir(repoRoot);
	}

	try {
		await runGitChecked(["worktree", "remove", "--force", managed.path], repoRoot, `Failed to remove worktree '${managed.name}'.`);
	} catch (error) {
		await pruneWorktrees(repoRoot);
		const stillRegistered = await getManagedWorktree(repoRoot, name);
		if (stillRegistered) {
			throw error;
		}
	}

	const branchDeleteResult = await runGit(["branch", "-D", managed.branch], repoRoot);
	if (branchDeleteResult.code !== 0) {
		const details = `${branchDeleteResult.stderr}\n${branchDeleteResult.stdout}`;
		if (!/branch .* not found/i.test(details)) {
			throw new Error(`Failed to delete managed branch '${managed.branch}'.\n${details.trim()}`);
		}
	}

	if (await pathExists(managed.path)) {
		const leftovers = await fs.readdir(managed.path);
		if (leftovers.length === 0) {
			await fs.rmdir(managed.path);
		}
	}

	return managed;
}
