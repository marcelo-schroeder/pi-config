import assert from "node:assert/strict";
import test from "node:test";
import {
	assertBranchExists,
	assertBranchMissing,
	createTempRepo,
	expectedWorktreePath,
	listWorktreePaths,
	runPiw,
} from "./helpers.js";

test("keeps a dirty managed worktree when the user chooses keep", async () => {
	const repo = await createTempRepo();
	const worktreePath = expectedWorktreePath(repo.repoPath, "feature-auth");

	try {
		const result = await runPiw({
			cwd: repo.repoPath,
			args: ["feature-auth"],
			env: {
				PIW_FAKE_PI_TOUCH: "notes.txt",
				PIW_ALLOW_NON_TTY_PROMPT: "1",
			},
			input: "k\n",
		});

		assert.equal(result.code, 0);
		assert.match(result.stdout, /Kept dirty worktree 'feature-auth'\./);
		const worktreePaths = await listWorktreePaths(repo.repoPath);
		assert.ok(worktreePaths.includes(worktreePath));
		await assertBranchExists(repo.repoPath, "piw/feature-auth");
	} finally {
		await repo.cleanup();
	}
});

test("deletes a dirty managed worktree when the user chooses delete", async () => {
	const repo = await createTempRepo();
	const worktreePath = expectedWorktreePath(repo.repoPath, "feature-auth");

	try {
		const result = await runPiw({
			cwd: repo.repoPath,
			args: ["feature-auth"],
			env: {
				PIW_FAKE_PI_TOUCH: "notes.txt",
				PIW_ALLOW_NON_TTY_PROMPT: "1",
			},
			input: "d\n",
		});

		assert.equal(result.code, 0);
		assert.match(result.stdout, /Deleted worktree 'feature-auth'\./);
		const worktreePaths = await listWorktreePaths(repo.repoPath);
		assert.ok(!worktreePaths.includes(worktreePath));
		await assertBranchMissing(repo.repoPath, "piw/feature-auth");
	} finally {
		await repo.cleanup();
	}
});

test("keep-clean preserves an auto-generated clean worktree", async () => {
	const repo = await createTempRepo();

	try {
		const result = await runPiw({
			cwd: repo.repoPath,
			args: ["--keep-clean"],
		});

		assert.equal(result.code, 0);
		assert.doesNotMatch(result.stdout, /Deleted worktree '/);
		const listResult = await runPiw({
			cwd: repo.repoPath,
			args: ["list", "--json"],
		});
		assert.equal(listResult.code, 0);
		const worktrees = JSON.parse(listResult.stdout);
		assert.equal(worktrees.length, 1);
		await assertBranchExists(repo.repoPath, worktrees[0].branch);
	} finally {
		await repo.cleanup();
	}
});

test("delete-clean removes a clean managed worktree after pi exits", async () => {
	const repo = await createTempRepo();
	const worktreePath = expectedWorktreePath(repo.repoPath, "feature-auth");

	try {
		const result = await runPiw({
			cwd: repo.repoPath,
			args: ["feature-auth", "--delete-clean"],
		});

		assert.equal(result.code, 0);
		assert.match(result.stdout, /Deleted worktree 'feature-auth'\./);
		const worktreePaths = await listWorktreePaths(repo.repoPath);
		assert.ok(!worktreePaths.includes(worktreePath));
		await assertBranchMissing(repo.repoPath, "piw/feature-auth");
	} finally {
		await repo.cleanup();
	}
});
