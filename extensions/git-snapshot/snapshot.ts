import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export const SNAPSHOT_MESSAGE_PREFIX = "pi snapshot:";

export interface CreateSnapshotOptions {
	repoPath: string;
	message?: string;
	trackedOnly?: boolean;
	signal?: AbortSignal;
}

export interface CreateSnapshotResult {
	created: boolean;
	reason: string | null;
	repoRoot: string;
	snapshotCommit: string | null;
	stashRef: string | null;
	message: string | null;
	includedUntracked: boolean;
	includedIgnored: boolean;
}

interface ProcessResult {
	code: number;
	stdout: Buffer;
	stderr: Buffer;
}

interface ProcessOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	stdin?: Uint8Array | string;
}

function normalizeText(buffer: Buffer): string {
	return buffer.toString("utf8").trim();
}

function processError(result: ProcessResult, fallback: string): Error {
	const stderr = normalizeText(result.stderr);
	const stdout = normalizeText(result.stdout);
	return new Error(stderr || stdout || fallback);
}

async function runProcess(command: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
	return await new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			signal: options.signal,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];

		child.stdout.on("data", (chunk) => {
			stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		child.stderr.on("data", (chunk) => {
			stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});

		child.on("error", (error) => {
			rejectPromise(error);
		});

		child.on("close", (code) => {
			resolvePromise({
				code: code ?? 1,
				stdout: Buffer.concat(stdoutChunks),
				stderr: Buffer.concat(stderrChunks),
			});
		});

		if (options.stdin !== undefined) {
			child.stdin.end(options.stdin);
		} else {
			child.stdin.end();
		}
	});
}

async function runGit(repoPath: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
	return await runProcess("git", ["-C", repoPath, ...args], options);
}

async function runGitChecked(repoPath: string, args: string[], fallback: string, options: ProcessOptions = {}): Promise<ProcessResult> {
	const result = await runGit(repoPath, args, options);
	if (result.code !== 0) {
		throw processError(result, fallback);
	}
	return result;
}

function formatTimestamp(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const absoluteOffset = Math.abs(offsetMinutes);
	const offsetHours = Math.floor(absoluteOffset / 60);
	const offsetRemainderMinutes = absoluteOffset % 60;

	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${sign}${pad(offsetHours)}${pad(offsetRemainderMinutes)}`;
}

function normalizeSnapshotMessage(message: string | undefined, repoName: string): string {
	const trimmed = message?.trim();
	if (trimmed) {
		return trimmed.startsWith(SNAPSHOT_MESSAGE_PREFIX) ? trimmed : `${SNAPSHOT_MESSAGE_PREFIX} ${trimmed}`;
	}
	return `${SNAPSHOT_MESSAGE_PREFIX} ${repoName} ${formatTimestamp(new Date())}`;
}

export async function resolveRepoRoot(repoPath: string, signal?: AbortSignal): Promise<string> {
	const absolutePath = resolve(repoPath);
	await access(absolutePath).catch(() => {
		throw new Error(`Repository path does not exist: ${absolutePath}`);
	});

	const insideWorkTree = await runGit(absolutePath, ["rev-parse", "--is-inside-work-tree"], { signal });
	if (insideWorkTree.code !== 0 || normalizeText(insideWorkTree.stdout) !== "true") {
		throw new Error(`Not inside a Git working tree: ${absolutePath}`);
	}

	const repoRootResult = await runGitChecked(
		absolutePath,
		["rev-parse", "--show-toplevel"],
		"Failed to resolve Git repository root.",
		{ signal },
	);
	return normalizeText(repoRootResult.stdout);
}

async function getBranchLabel(repoRoot: string, signal?: AbortSignal): Promise<string> {
	const result = await runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], { signal });
	if (result.code !== 0) {
		return "(detached HEAD)";
	}
	return normalizeText(result.stdout) || "(detached HEAD)";
}

export async function createSnapshot(options: CreateSnapshotOptions): Promise<CreateSnapshotResult> {
	const repoRoot = await resolveRepoRoot(options.repoPath, options.signal);
	const includeUntracked = !options.trackedOnly;

	const headCommitResult = await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"], { signal: options.signal });
	if (headCommitResult.code !== 0) {
		throw new Error("This repository does not have a HEAD commit yet; create an initial commit first.");
	}
	const headCommit = normalizeText(headCommitResult.stdout);
	const repoName = basename(repoRoot);
	const branchLabel = await getBranchLabel(repoRoot, options.signal);
	const shortHead = headCommit.slice(0, 7);
	const headSubjectResult = await runGitChecked(repoRoot, ["log", "-1", "--format=%s", headCommit], "Failed to read HEAD subject.", {
		signal: options.signal,
	});
	const headSubject = normalizeText(headSubjectResult.stdout);
	const message = normalizeSnapshotMessage(options.message, repoName);

	let tempDir: string | null = null;
	try {
		let untrackedList: Uint8Array = new Uint8Array();
		if (includeUntracked) {
			const untrackedResult = await runGitChecked(
				repoRoot,
				["ls-files", "--others", "--exclude-standard", "-z"],
				"Failed to list untracked files.",
				{ signal: options.signal },
			);
			untrackedList = untrackedResult.stdout;
		}
		const hasUntracked = untrackedList.length > 0;

		const trackedCommitResult = await runGitChecked(repoRoot, ["stash", "create", message], "git stash create failed", {
			signal: options.signal,
		});
		const trackedCommit = normalizeText(trackedCommitResult.stdout);

		if (!trackedCommit && !hasUntracked) {
			return {
				created: false,
				reason: "no tracked or untracked changes found",
				repoRoot,
				snapshotCommit: null,
				stashRef: null,
				message: null,
				includedUntracked: false,
				includedIgnored: false,
			};
		}

		let indexCommit: string;
		let worktreeTree: string;
		if (trackedCommit) {
			const indexCommitResult = await runGitChecked(
				repoRoot,
				["rev-parse", `${trackedCommit}^2`],
				"Failed to resolve index commit from snapshot.",
				{ signal: options.signal },
			);
			indexCommit = normalizeText(indexCommitResult.stdout);

			const worktreeTreeResult = await runGitChecked(
				repoRoot,
				["rev-parse", `${trackedCommit}^{tree}`],
				"Failed to resolve worktree tree from snapshot.",
				{ signal: options.signal },
			);
			worktreeTree = normalizeText(worktreeTreeResult.stdout);
		} else {
			const indexTreeResult = await runGitChecked(repoRoot, ["write-tree"], "Failed to write index tree.", {
				signal: options.signal,
			});
			const indexTree = normalizeText(indexTreeResult.stdout);

			const indexCommitResult = await runGitChecked(
				repoRoot,
				[
					"commit-tree",
					indexTree,
					"-p",
					headCommit,
					"-m",
					`index on ${branchLabel}: ${shortHead} ${headSubject}`,
				],
				"Failed to create synthetic index commit for snapshot.",
				{ signal: options.signal },
			);
			indexCommit = normalizeText(indexCommitResult.stdout);

			const headTreeResult = await runGitChecked(repoRoot, ["rev-parse", `${headCommit}^{tree}`], "Failed to resolve HEAD tree.", {
				signal: options.signal,
			});
			worktreeTree = normalizeText(headTreeResult.stdout);
		}

		let untrackedCommit = "";
		if (hasUntracked) {
			tempDir = await mkdtemp(join(tmpdir(), "git-workspace-snapshot-"));
			const scratchIndexPath = join(tempDir, "index");
			const tempEnv = { ...process.env, GIT_INDEX_FILE: scratchIndexPath };

			await runGitChecked(repoRoot, ["read-tree", "--empty"], "Failed to initialize scratch index for untracked snapshot.", {
				signal: options.signal,
				env: tempEnv,
			});
			await runGitChecked(
				repoRoot,
				["update-index", "--add", "-z", "--stdin"],
				"Failed to stage untracked files into scratch index.",
				{
					signal: options.signal,
					env: tempEnv,
					stdin: untrackedList,
				},
			);
			const untrackedTreeResult = await runGitChecked(repoRoot, ["write-tree"], "Failed to write untracked tree.", {
				signal: options.signal,
				env: tempEnv,
			});
			const untrackedTree = normalizeText(untrackedTreeResult.stdout);
			const untrackedCommitResult = await runGitChecked(
				repoRoot,
				[
					"commit-tree",
					untrackedTree,
					"-m",
					`untracked files on ${branchLabel}: ${shortHead} ${headSubject}`,
				],
				"Failed to create untracked-files commit for snapshot.",
				{ signal: options.signal },
			);
			untrackedCommit = normalizeText(untrackedCommitResult.stdout);
		}

		let finalCommit = trackedCommit;
		if (!(trackedCommit && !untrackedCommit)) {
			const commitTreeArgs = ["commit-tree", worktreeTree, "-p", headCommit, "-p", indexCommit];
			if (untrackedCommit) {
				commitTreeArgs.push("-p", untrackedCommit);
			}
			commitTreeArgs.push("-m", `On ${branchLabel}: ${message}`);
			const finalCommitResult = await runGitChecked(repoRoot, commitTreeArgs, "Failed to create final stash commit.", {
				signal: options.signal,
			});
			finalCommit = normalizeText(finalCommitResult.stdout);
		}

		await runGitChecked(repoRoot, ["stash", "store", "-m", message, finalCommit], "Failed to store snapshot in git stash.", {
			signal: options.signal,
		});
		const stashCommitResult = await runGitChecked(repoRoot, ["rev-parse", "stash@{0}"], "Failed to read stored stash reference.", {
			signal: options.signal,
		});
		const stashCommit = normalizeText(stashCommitResult.stdout);
		if (stashCommit !== finalCommit) {
			throw new Error("Created stash commit does not match the stored stash reference.");
		}

		return {
			created: true,
			reason: null,
			repoRoot,
			snapshotCommit: stashCommit,
			stashRef: "stash@{0}",
			message,
			includedUntracked: hasUntracked,
			includedIgnored: false,
		};
	} finally {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
		}
	}
}
