import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
	assertBranchExists,
	assertBranchMissing,
	createTempRepo,
	expectedWorktreePath,
	listWorktreePaths,
	runPiw,
} from "./helpers.js";

test("reuses an existing managed worktree and reports it in list/path commands", async () => {
	const repo = await createTempRepo();
	const firstCapture = path.join(repo.tempRoot, "capture", "first.json");
	const secondCapture = path.join(repo.tempRoot, "capture", "second.json");
	const worktreePath = expectedWorktreePath(repo.repoPath, "feature-auth");

	try {
		const firstRun = await runPiw({
			cwd: repo.repoPath,
			args: ["feature-auth"],
			env: { PIW_FAKE_PI_CAPTURE: firstCapture },
		});
		assert.equal(firstRun.code, 0);

		const secondRun = await runPiw({
			cwd: repo.repoPath,
			args: ["feature-auth"],
			env: { PIW_FAKE_PI_CAPTURE: secondCapture },
		});
		assert.equal(secondRun.code, 0);
		assert.match(secondRun.stdout, /Reusing worktree 'feature-auth'\./);

		const worktreePaths = await listWorktreePaths(repo.repoPath);
		assert.equal(worktreePaths.filter((candidate) => candidate === worktreePath).length, 1);
		await assertBranchExists(repo.repoPath, "piw/feature-auth");

		const listResult = await runPiw({
			cwd: repo.repoPath,
			args: ["list"],
		});
		assert.equal(listResult.code, 0);
		assert.match(listResult.stdout, /feature-auth/);
		assert.match(listResult.stdout, new RegExp(worktreePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

		const pathResult = await runPiw({
			cwd: repo.repoPath,
			args: ["path", "feature-auth"],
		});
		assert.equal(pathResult.code, 0);
		assert.equal(pathResult.stdout.trim(), worktreePath);
	} finally {
		await repo.cleanup();
	}
});

test("rm removes a managed worktree and its managed branch", async () => {
	const repo = await createTempRepo();
	const worktreePath = expectedWorktreePath(repo.repoPath, "feature-auth");

	try {
		const createResult = await runPiw({
			cwd: repo.repoPath,
			args: ["feature-auth"],
		});
		assert.equal(createResult.code, 0);

		const removeResult = await runPiw({
			cwd: repo.repoPath,
			args: ["rm", "feature-auth", "--yes"],
		});
		assert.equal(removeResult.code, 0);
		assert.match(removeResult.stdout, /Removed worktree 'feature-auth'\./);

		const worktreePaths = await listWorktreePaths(repo.repoPath);
		assert.ok(!worktreePaths.includes(worktreePath));
		await assertBranchMissing(repo.repoPath, "piw/feature-auth");
	} finally {
		await repo.cleanup();
	}
});
