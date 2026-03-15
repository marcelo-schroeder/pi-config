import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
	assertBranchExists,
	assertBranchMissing,
	createTempRepo,
	expectedWorktreePath,
	git,
	listWorktreePaths,
	readJson,
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

test("keeps an auto-generated worktree with unintegrated commits when no interactive prompt is available", async () => {
	const repo = await createTempRepo();
	const capturePath = path.join(repo.tempRoot, "capture", "auto-committed.json");

	try {
		const result = await runPiw({
			cwd: repo.repoPath,
			args: [],
			env: {
				PIW_FAKE_PI_CAPTURE: capturePath,
				PIW_FAKE_PI_COMMIT: "notes.txt",
			},
		});

		assert.equal(result.code, 0);
		const capture = await readJson(capturePath);
		const name = capture.env.PI_WORKTREE_NAME;
		const worktreePath = expectedWorktreePath(repo.repoPath, name);
		assert.match(result.stdout, new RegExp(`Kept worktree '${name}' with commits not merged into 'main' or 'origin/main'\\.`));
		const worktreePaths = await listWorktreePaths(repo.repoPath);
		assert.ok(worktreePaths.includes(worktreePath));
		await assertBranchExists(repo.repoPath, `piw/${name}`);
	} finally {
		await repo.cleanup();
	}
});

test("delete-clean still prompts when a worktree has unintegrated commits", async () => {
	const repo = await createTempRepo();
	const worktreePath = expectedWorktreePath(repo.repoPath, "feature-auth");

	try {
		const result = await runPiw({
			cwd: repo.repoPath,
			args: ["feature-auth", "--delete-clean"],
			env: {
				PIW_FAKE_PI_COMMIT: "notes.txt",
				PIW_ALLOW_NON_TTY_PROMPT: "1",
			},
			input: "k\n",
		});

		assert.equal(result.code, 0);
		assert.match(result.stdout, /The worktree has commits not merged into 'main' or 'origin\/main'\./);
		assert.match(result.stdout, /Kept worktree 'feature-auth' with commits not merged into 'main' or 'origin\/main'\./);
		const worktreePaths = await listWorktreePaths(repo.repoPath);
		assert.ok(worktreePaths.includes(worktreePath));
		await assertBranchExists(repo.repoPath, "piw/feature-auth");
	} finally {
		await repo.cleanup();
	}
});

test("deletes a worktree with unintegrated commits when the user chooses delete", async () => {
	const repo = await createTempRepo();
	const worktreePath = expectedWorktreePath(repo.repoPath, "feature-auth");

	try {
		const result = await runPiw({
			cwd: repo.repoPath,
			args: ["feature-auth"],
			env: {
				PIW_FAKE_PI_COMMIT: "notes.txt",
				PIW_ALLOW_NON_TTY_PROMPT: "1",
			},
			input: "d\n",
		});

		assert.equal(result.code, 0);
		assert.match(result.stdout, /The worktree has commits not merged into 'main' or 'origin\/main'\./);
		assert.match(result.stdout, /Deleted worktree 'feature-auth'\./);
		const worktreePaths = await listWorktreePaths(repo.repoPath);
		assert.ok(!worktreePaths.includes(worktreePath));
		await assertBranchMissing(repo.repoPath, "piw/feature-auth");
	} finally {
		await repo.cleanup();
	}
});

test("delete-clean removes a worktree once its commits are on the local target branch", async () => {
	const repo = await createTempRepo();
	const worktreePath = expectedWorktreePath(repo.repoPath, "feature-auth");

	try {
		const firstRun = await runPiw({
			cwd: repo.repoPath,
			args: ["feature-auth"],
			env: {
				PIW_FAKE_PI_COMMIT: "notes.txt",
				PIW_ALLOW_NON_TTY_PROMPT: "1",
			},
			input: "k\n",
		});

		assert.equal(firstRun.code, 0);
		assert.match(firstRun.stdout, /Kept worktree 'feature-auth' with commits not merged into 'main' or 'origin\/main'\./);
		await assertBranchExists(repo.repoPath, "piw/feature-auth");
		assert.ok((await listWorktreePaths(repo.repoPath)).includes(worktreePath));

		await git(["merge", "--ff-only", "piw/feature-auth"], repo.repoPath);

		const secondRun = await runPiw({
			cwd: repo.repoPath,
			args: ["feature-auth", "--delete-clean"],
		});

		assert.equal(secondRun.code, 0);
		assert.doesNotMatch(secondRun.stdout, /The worktree has commits not merged into/);
		assert.doesNotMatch(secondRun.stdout, /Choose \[k\/d\/c\]/);
		assert.match(secondRun.stdout, /Deleted worktree 'feature-auth'\./);
		const worktreePaths = await listWorktreePaths(repo.repoPath);
		assert.ok(!worktreePaths.includes(worktreePath));
		await assertBranchMissing(repo.repoPath, "piw/feature-auth");
	} finally {
		await repo.cleanup();
	}
});

test("keeps a metadata-incomplete worktree when clean deletion safety cannot be verified", async () => {
	const repo = await createTempRepo();
	const worktreePath = expectedWorktreePath(repo.repoPath, "legacy");

	try {
		await git(["worktree", "add", "-b", "piw/legacy", worktreePath, "main"], repo.repoPath);

		const result = await runPiw({
			cwd: repo.repoPath,
			args: ["legacy", "--delete-clean"],
		});

		assert.equal(result.code, 0);
		assert.match(result.stdout, /Kept protected worktree 'legacy'\./);
		const worktreePaths = await listWorktreePaths(repo.repoPath);
		assert.ok(worktreePaths.includes(worktreePath));
		await assertBranchExists(repo.repoPath, "piw/legacy");
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
