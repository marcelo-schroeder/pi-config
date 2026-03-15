import { constants } from "node:os";
import { spawn } from "node:child_process";
import { buildWorktreeChildEnv } from "./launch.js";

function getSignalExitCode(signalName) {
	if (!signalName) return 1;
	const signalNumber = constants.signals[signalName];
	return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}

function shouldRunHook(hook, mode) {
	return hook.when === "always" || hook.when === mode;
}

function describeHookFailure(hook, code, signal) {
	if (typeof code === "number") {
		return `Hook '${hook.name}' failed with exit code ${code}.`;
	}

	if (signal) {
		return `Hook '${hook.name}' terminated with signal ${signal} (exit code ${getSignalExitCode(signal)}).`;
	}

	return `Hook '${hook.name}' failed.`;
}

async function runHookCommand(hook, { session, originalCwd, mode }) {
	const env = buildWorktreeChildEnv({
		session,
		originalCwd,
		extraEnv: {
			PIW_HOOK_EVENT: hook.event,
			PIW_HOOK_MODE: mode,
			PIW_HOOK_NAME: hook.name,
			PIW_HOOK_SOURCE_KIND: hook.sourceKind,
			PIW_HOOK_SOURCE_PATH: hook.sourcePath,
		},
	});

	return await new Promise((resolve, reject) => {
		const child = spawn(hook.command, {
			cwd: session.path,
			env,
			stdio: "inherit",
			shell: true,
		});

		child.once("error", reject);
		child.once("exit", (code, signal) => {
			resolve({ code, signal });
		});
	});
}

export async function runConfiguredHooks({ config, event, mode, session, originalCwd, debug = false }) {
	const hooks = config?.hooks?.[event] ?? [];
	for (const hook of hooks) {
		if (!shouldRunHook(hook, mode)) {
			continue;
		}

		console.log(`Running ${event} hook '${hook.name}' (${mode}).`);
		if (debug) {
			console.error(`[piw] hook source`, hook.sourcePath);
			console.error(`[piw] hook command`, hook.command);
		}

		const { code, signal } = await runHookCommand(hook, { session, originalCwd, mode });
		if (code === 0) {
			continue;
		}

		const message = describeHookFailure(hook, code, signal);
		if (hook.onFailure === "continue") {
			console.warn(`piw: ${message} Continuing because onFailure=continue.`);
			continue;
		}

		throw new Error(message);
	}
}
