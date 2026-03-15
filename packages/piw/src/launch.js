import path from "node:path";
import { constants } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const SRC_DIR = path.dirname(THIS_FILE);
const PACKAGE_ROOT = path.dirname(SRC_DIR);
const WORKTREE_EXTENSION_PATH = path.join(PACKAGE_ROOT, "extensions", "worktree-awareness", "index.ts");

function hasExplicitExtension(piArgs, extensionPath) {
	for (let index = 0; index < piArgs.length; index += 1) {
		if (piArgs[index] === "--extension" && piArgs[index + 1] === extensionPath) {
			return true;
		}
	}
	return false;
}

function getSignalExitCode(signalName) {
	if (!signalName) return 1;
	const signalNumber = constants.signals[signalName];
	return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}

export function getWorktreeExtensionPath() {
	return WORKTREE_EXTENSION_PATH;
}

export function buildWorktreeChildEnv({ session, originalCwd, extraEnv = {} }) {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_WORKTREE_")));
	env.PI_WORKTREE_SESSION = "1";
	env.PI_WORKTREE_NAME = session.name;
	env.PI_WORKTREE_PATH = session.path;
	env.PI_WORKTREE_BRANCH = session.branch;
	env.PI_WORKTREE_REPO_ROOT = session.repoRoot;
	env.PI_WORKTREE_ORIGINAL_CWD = originalCwd;

	if (session.metadata) {
		env.PI_WORKTREE_METADATA_JSON = JSON.stringify(session.metadata);
	}

	return {
		...env,
		...extraEnv,
	};
}

export async function launchPiSession({ session, piArgs, piBin, originalCwd }) {
	const resolvedPiBin = piBin || process.env.PIW_PI_BIN || "pi";
	const launchArgs = hasExplicitExtension(piArgs, WORKTREE_EXTENSION_PATH)
		? [...piArgs]
		: ["--extension", WORKTREE_EXTENSION_PATH, ...piArgs];
	const env = buildWorktreeChildEnv({ session, originalCwd });

	return await new Promise((resolve, reject) => {
		const child = spawn(resolvedPiBin, launchArgs, {
			cwd: session.path,
			env,
			stdio: "inherit",
		});

		child.once("error", (error) => {
			if (error?.code === "ENOENT") {
				reject(new Error(`Unable to launch pi using '${resolvedPiBin}'.`));
				return;
			}
			reject(error);
		});

		child.once("exit", (code, signal) => {
			resolve(typeof code === "number" ? code : getSignalExitCode(signal));
		});
	});
}
