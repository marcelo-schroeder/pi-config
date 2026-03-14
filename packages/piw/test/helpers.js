import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.dirname(TEST_DIR);
const WRAPPER_PATH = path.join(PACKAGE_ROOT, "bin", "piw.js");
const FAKE_PI_PATH = path.join(TEST_DIR, "fixtures", "fake-pi.js");

export async function git(args, cwd, { allowFailure = false } = {}) {
	try {
		const { stdout = "", stderr = "" } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
		return { code: 0, stdout, stderr };
	} catch (error) {
		if (!allowFailure) {
			throw error;
		}
		return {
			code: typeof error?.code === "number" ? error.code : 1,
			stdout: error?.stdout ?? "",
			stderr: error?.stderr ?? error?.message ?? "",
		};
	}
}

export async function createTempRepo() {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "piw-"));
	const repoPath = path.join(tempRoot, "repo");
	await mkdir(repoPath, { recursive: true });

	await git(["init", "-b", "main"], repoPath);
	await git(["config", "user.email", "piw-tests@example.com"], repoPath);
	await git(["config", "user.name", "piw tests"], repoPath);
	await writeFile(path.join(repoPath, "README.md"), "# temp repo\n");
	await git(["add", "README.md"], repoPath);
	await git(["commit", "-m", "initial commit"], repoPath);

	const canonicalRepoPath = await realpath(repoPath);
	const canonicalTempRoot = await realpath(tempRoot);

	return {
		repoPath: canonicalRepoPath,
		tempRoot: canonicalTempRoot,
		async cleanup() {
			await rm(canonicalTempRoot, { recursive: true, force: true });
		},
	};
}

export function expectedWorktreePath(repoPath, name) {
	return path.join(path.dirname(repoPath), `${path.basename(repoPath)}.worktrees`, name);
}

export async function readJson(jsonPath) {
	const raw = await readFile(jsonPath, "utf8");
	return JSON.parse(raw);
}

export async function runPiw({ cwd, args = [], env = {}, input = null } = {}) {
	const child = spawn(process.execPath, [WRAPPER_PATH, ...args], {
		cwd,
		env: {
			...process.env,
			PIW_PI_BIN: FAKE_PI_PATH,
			...env,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";

	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	if (input !== null) {
		child.stdin.write(input);
	}
	child.stdin.end();

	const code = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});

	return { code, stdout, stderr };
}

export async function assertBranchExists(repoPath, branchName) {
	const result = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repoPath, { allowFailure: true });
	assert.equal(result.code, 0, `Expected branch '${branchName}' to exist.`);
}

export async function assertBranchMissing(repoPath, branchName) {
	const result = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repoPath, { allowFailure: true });
	assert.notEqual(result.code, 0, `Expected branch '${branchName}' to be missing.`);
}

export async function listWorktreePaths(repoPath) {
	const result = await git(["worktree", "list", "--porcelain"], repoPath);
	return result.stdout
		.split(/\r?\n/)
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
}
