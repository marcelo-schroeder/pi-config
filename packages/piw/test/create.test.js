import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
	assertBranchExists,
	assertBranchMissing,
	createTempRepo,
	expectedWorktreePath,
	listWorktreePaths,
	readJson,
	runPiw,
} from "./helpers.js";

test("creates a named managed worktree and launches pi with worktree awareness", async () => {
	const repo = await createTempRepo();
	const capturePath = path.join(repo.tempRoot, "capture", "named.json");

	try {
		const result = await runPiw({
			cwd: repo.repoPath,
			args: ["feature-auth"],
			env: {
				PIW_FAKE_PI_CAPTURE: capturePath,
			},
		});

		assert.equal(result.code, 0);
		const worktreePath = expectedWorktreePath(repo.repoPath, "feature-auth");
		const capture = await readJson(capturePath);
		const worktreePaths = await listWorktreePaths(repo.repoPath);

		assert.equal(capture.cwd, worktreePath);
		assert.equal(capture.env.PI_WORKTREE_SESSION, "1");
		assert.equal(capture.env.PI_WORKTREE_NAME, "feature-auth");
		assert.equal(capture.env.PI_WORKTREE_PATH, worktreePath);
		assert.equal(capture.env.PI_WORKTREE_BRANCH, "piw/feature-auth");
		assert.equal(capture.env.PI_WORKTREE_REPO_ROOT, repo.repoPath);
		assert.equal(capture.env.PI_WORKTREE_ORIGINAL_CWD, repo.repoPath);
		assert.ok(capture.argv.includes("--extension"));
		assert.ok(
			capture.argv.some((arg) => arg.endsWith("packages/piw/extensions/worktree-awareness/index.ts")),
			"expected wrapper to pass the private worktree-awareness extension",
		);
		assert.ok(worktreePaths.includes(worktreePath));
		await assertBranchExists(repo.repoPath, "piw/feature-auth");
	} finally {
		await repo.cleanup();
	}
});

test("creates an auto-named managed worktree when no name is provided and deletes it on clean exit", async () => {
	const repo = await createTempRepo();
	const capturePath = path.join(repo.tempRoot, "capture", "auto.json");

	try {
		const result = await runPiw({
			cwd: repo.repoPath,
			args: [],
			env: {
				PIW_FAKE_PI_CAPTURE: capturePath,
			},
		});

		assert.equal(result.code, 0);
		const capture = await readJson(capturePath);
		const name = capture.env.PI_WORKTREE_NAME;
		const worktreePath = expectedWorktreePath(repo.repoPath, name);
		const worktreePaths = await listWorktreePaths(repo.repoPath);
		assert.match(name, /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+(?:-[0-9]+)?$/);
		assert.equal(capture.env.PI_WORKTREE_BRANCH, `piw/${name}`);
		assert.equal(capture.env.PI_WORKTREE_PATH, worktreePath);
		assert.match(result.stdout, new RegExp(`Deleted worktree '${name}'\\.`));
		assert.ok(!worktreePaths.includes(worktreePath));
		await assertBranchMissing(repo.repoPath, `piw/${name}`);
	} finally {
		await repo.cleanup();
	}
});
