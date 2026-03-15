import fs from "node:fs/promises";
import path from "node:path";

export const PIW_SHARED_CONFIG_FILENAME = "piw.config.json";
export const PIW_LOCAL_CONFIG_FILENAME = ".piw.local.json";
const SUPPORTED_HOOK_EVENTS = new Set(["session-setup"]);
const SUPPORTED_HOOK_MODES = new Set(["create", "reuse", "always"]);
const SUPPORTED_HOOK_FAILURE_ACTIONS = new Set(["abort", "continue"]);

function trimToNull(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function createEmptyHooks() {
	return {
		"session-setup": [],
	};
}

function createConfigError(message, filePath) {
	return new Error(`Invalid piw hook config at '${filePath}': ${message}`);
}

async function readJsonConfigFile(filePath) {
	try {
		const raw = await fs.readFile(filePath, "utf8");
		try {
			return JSON.parse(raw);
		} catch {
			throw new Error(`Failed to parse piw hook config at '${filePath}'.`);
		}
	} catch (error) {
		if (error?.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

function normalizeHook(rawHook, { event, filePath, sourceKind, index }) {
	if (!rawHook || typeof rawHook !== "object" || Array.isArray(rawHook)) {
		throw createConfigError(`hook #${index + 1} for '${event}' must be an object.`, filePath);
	}

	const command = trimToNull(rawHook.command);
	if (!command) {
		throw createConfigError(`hook #${index + 1} for '${event}' must define a non-empty 'command'.`, filePath);
	}

	const when = trimToNull(rawHook.when) ?? "always";
	if (!SUPPORTED_HOOK_MODES.has(when)) {
		throw createConfigError(
			`hook '${trimToNull(rawHook.name) ?? command}' for '${event}' has unsupported 'when' value '${when}'.`,
			filePath,
		);
	}

	const onFailure = trimToNull(rawHook.onFailure) ?? "abort";
	if (!SUPPORTED_HOOK_FAILURE_ACTIONS.has(onFailure)) {
		throw createConfigError(
			`hook '${trimToNull(rawHook.name) ?? command}' for '${event}' has unsupported 'onFailure' value '${onFailure}'.`,
			filePath,
		);
	}

	return {
		event,
		name: trimToNull(rawHook.name) ?? command,
		command,
		when,
		onFailure,
		sourceKind,
		sourcePath: filePath,
	};
}

function normalizeConfig(rawConfig, { filePath, sourceKind }) {
	if (rawConfig === null) {
		return {
			path: filePath,
			sourceKind,
			loaded: false,
			hooks: createEmptyHooks(),
		};
	}

	if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
		throw createConfigError("expected a top-level JSON object.", filePath);
	}

	const normalizedHooks = createEmptyHooks();
	const rawHooks = rawConfig.hooks;
	if (rawHooks !== undefined && rawHooks !== null) {
		if (typeof rawHooks !== "object" || Array.isArray(rawHooks)) {
			throw createConfigError("'hooks' must be an object when provided.", filePath);
		}

		for (const [event, hookEntries] of Object.entries(rawHooks)) {
			if (!SUPPORTED_HOOK_EVENTS.has(event)) {
				throw createConfigError(`unsupported hook event '${event}'.`, filePath);
			}

			if (!Array.isArray(hookEntries)) {
				throw createConfigError(`'hooks.${event}' must be an array.`, filePath);
			}

			normalizedHooks[event] = hookEntries.map((hook, index) => normalizeHook(hook, { event, filePath, sourceKind, index }));
		}
	}

	return {
		path: filePath,
		sourceKind,
		loaded: true,
		hooks: normalizedHooks,
	};
}

function mergeHooks(configs) {
	const mergedHooks = createEmptyHooks();
	for (const config of configs) {
		for (const event of Object.keys(mergedHooks)) {
			mergedHooks[event].push(...config.hooks[event]);
		}
	}
	return mergedHooks;
}

export async function loadPiwHookConfig({ sharedConfigRoot, localConfigRoot }) {
	const sharedPath = path.join(sharedConfigRoot, PIW_SHARED_CONFIG_FILENAME);
	const localPath = path.join(localConfigRoot, PIW_LOCAL_CONFIG_FILENAME);
	const shared = normalizeConfig(await readJsonConfigFile(sharedPath), {
		filePath: sharedPath,
		sourceKind: "shared",
	});
	const local = normalizeConfig(await readJsonConfigFile(localPath), {
		filePath: localPath,
		sourceKind: "local",
	});
	const configs = [shared, local];

	return {
		sharedConfigRoot,
		localConfigRoot,
		loadedFiles: configs.filter((config) => config.loaded).map((config) => config.path),
		hooks: mergeHooks(configs),
	};
}
