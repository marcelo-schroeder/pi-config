import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createSnapshot } from "./snapshot.ts";

const execFileAsync = promisify(execFile);

async function run(command: string, args: string[], cwd: string): Promise<string> {
	const result = await execFileAsync(command, args, { cwd, encoding: "utf8" });
	return result.stdout.trim();
}

async function git(repoPath: string, ...args: string[]): Promise<string> {
	return await run("git", args, repoPath);
}

async function initRepo(name: string): Promise<{ workspace: string; repoPath: string }> {
	const workspace = await mkdtemp(join(tmpdir(), `git-snapshot-smoke-${name}-`));
	const repoPath = join(workspace, "repo");
	await mkdir(repoPath, { recursive: true });

	await git(repoPath, "init", "-q");
	await git(repoPath, "config", "user.name", "Smoke Test");
	await git(repoPath, "config", "user.email", "smoke@example.com");
	await writeFile(join(repoPath, "tracked.txt"), "base\n", "utf8");
	await git(repoPath, "add", "tracked.txt");
	await git(repoPath, "commit", "-q", "-m", "chore: initial");

	return { workspace, repoPath };
}

async function testDirtyRepoFromRoot(): Promise<void> {
	const { workspace, repoPath } = await initRepo("root");
	try {
		await writeFile(join(repoPath, "tracked.txt"), "changed\n", "utf8");
		await writeFile(join(repoPath, "untracked.txt"), "new\n", "utf8");
		const statusBefore = await git(repoPath, "status", "--short");
		const expectedRepoRoot = await git(repoPath, "rev-parse", "--show-toplevel");

		const result = await createSnapshot({ repoPath });
		assert.equal(result.created, true);
		assert.equal(result.repoRoot, expectedRepoRoot);
		assert.equal(result.stashRef, "stash@{0}");
		assert.equal(result.includedUntracked, true);

		const statusAfter = await git(repoPath, "status", "--short");
		assert.equal(statusAfter, statusBefore);

		const latestMessage = await git(repoPath, "stash", "list", "-1", "--format=%gs");
		assert.match(latestMessage, /^pi snapshot:/);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

async function testDirtyRepoFromSubdirTrackedOnly(): Promise<void> {
	const { workspace, repoPath } = await initRepo("subdir");
	try {
		const subdirPath = join(repoPath, "nested", "path");
		await mkdir(subdirPath, { recursive: true });
		await writeFile(join(repoPath, "tracked.txt"), "changed\n", "utf8");
		await writeFile(join(repoPath, "untracked.txt"), "new\n", "utf8");
		const statusBefore = await git(repoPath, "status", "--short");
		const expectedRepoRoot = await git(repoPath, "rev-parse", "--show-toplevel");

		const result = await createSnapshot({ repoPath: subdirPath, trackedOnly: true });
		assert.equal(result.created, true);
		assert.equal(result.repoRoot, expectedRepoRoot);
		assert.equal(result.includedUntracked, false);

		const statusAfter = await git(repoPath, "status", "--short");
		assert.equal(statusAfter, statusBefore);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

async function testCleanRepoReturnsFalse(): Promise<void> {
	const { workspace, repoPath } = await initRepo("clean");
	try {
		const expectedRepoRoot = await git(repoPath, "rev-parse", "--show-toplevel");
		const result = await createSnapshot({ repoPath });
		assert.equal(result.created, false);
		assert.equal(result.reason, "no tracked or untracked changes found");
		assert.equal(result.repoRoot, expectedRepoRoot);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

async function testInvalidRepoFailsClearly(): Promise<void> {
	await assert.rejects(
		() => createSnapshot({ repoPath: "/tmp/pi-config-git-snapshot-smoke-invalid-path" }),
		(error: unknown) => error instanceof Error && /Repository path does not exist/.test(error.message),
	);
}

async function main(): Promise<void> {
	await testDirtyRepoFromRoot();
	await testDirtyRepoFromSubdirTrackedOnly();
	await testCleanRepoReturnsFalse();
	await testInvalidRepoFailsClearly();
	console.log("git-snapshot smoke tests passed");
}

await main();
