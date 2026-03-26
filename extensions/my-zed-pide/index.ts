import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

const INSTALL_COMMAND = "my-zed-pide-install";
const REMOVE_COMMAND = "my-zed-pide-remove";
const KEY_SEQUENCE = "ctrl-alt-;";
const KEY_SEQUENCE_LABEL = "Ctrl+Alt+;";
const KEYMAP_CONTEXT = "Workspace";
const TASK_LABEL = "pi-config: export current Zed file/selection";
const HELPER_FILE_NAME = "pi-config-zed-export-ide-selection.mjs";
const SELECTION_FILE = path.join(os.homedir(), ".pi", "ide-selection.json");
const MANAGED_BINDING_VALUE = ["task::Spawn", { task_name: TASK_LABEL }] as const;

type NotifyLevel = "info" | "warning" | "error";

type JsonObject = Record<string, unknown>;

type KeymapEntry = JsonObject & {
	bindings?: Record<string, unknown>;
};

type TaskDefinition = JsonObject;

type TasksDocument =
	| { kind: "array"; tasks: TaskDefinition[] }
	| { kind: "object"; root: JsonObject & { tasks: TaskDefinition[] }; tasks: TaskDefinition[] };

interface InstallResult {
	helperChanged: boolean;
	keymapChanged: boolean;
	tasksChanged: boolean;
	conflictingBindings: number;
	zedConfigDir: string;
	helperPath: string;
	keymapPath: string;
	tasksPath: string;
}

interface RemoveResult {
	helperRemoved: boolean;
	keymapChanged: boolean;
	tasksChanged: boolean;
	selectionCleared: boolean;
	zedConfigDir: string;
}

function notify(ctx: ExtensionCommandContext, message: string, level: NotifyLevel = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}

	const line = `${level.toUpperCase()}: ${message}`;
	if (level === "error") {
		console.error(line);
	} else {
		console.log(line);
	}
}

function usage(commandName: string): string {
	return `Usage: /${commandName}`;
}

function validateInvocation(commandName: string, args: string, ctx: ExtensionCommandContext): boolean {
	const trimmed = args.trim();
	if (!trimmed) return true;

	if (trimmed === "help" || trimmed === "--help" || trimmed === "-h") {
		notify(ctx, usage(commandName), "info");
		return false;
	}

	throw new Error(`/${commandName} does not accept arguments. ${usage(commandName)}`);
}

function getZedConfigDir(): string {
	if (process.platform === "win32") {
		const appData = process.env.APPDATA?.trim();
		if (appData) {
			return path.join(appData, "Zed");
		}
		return path.join(os.homedir(), "AppData", "Roaming", "Zed");
	}

	const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
	if (xdgConfigHome) {
		return path.join(xdgConfigHome, "zed");
	}

	return path.join(os.homedir(), ".config", "zed");
}

function stripJsonComments(input: string): string {
	let output = "";
	let inString = false;
	let escaped = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let index = 0; index < input.length; index += 1) {
		const char = input[index];
		const next = input[index + 1];

		if (inLineComment) {
			if (char === "\n") {
				inLineComment = false;
				output += char;
			}
			continue;
		}

		if (inBlockComment) {
			if (char === "*" && next === "/") {
				inBlockComment = false;
				index += 1;
				continue;
			}

			if (char === "\n") {
				output += char;
			}
			continue;
		}

		if (inString) {
			output += char;
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			output += char;
			continue;
		}

		if (char === "/" && next === "/") {
			inLineComment = true;
			index += 1;
			continue;
		}

		if (char === "/" && next === "*") {
			inBlockComment = true;
			index += 1;
			continue;
		}

		output += char;
	}

	return output;
}

function stripTrailingCommas(input: string): string {
	let output = "";
	let inString = false;
	let escaped = false;

	for (let index = 0; index < input.length; index += 1) {
		const char = input[index];

		if (inString) {
			output += char;
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			output += char;
			continue;
		}

		if (char === ",") {
			let nextIndex = index + 1;
			while (nextIndex < input.length && /\s/.test(input[nextIndex])) {
				nextIndex += 1;
			}

			const next = input[nextIndex];
			if (next === "]" || next === "}") {
				continue;
			}
		}

		output += char;
	}

	return output;
}

function parseJsonc(text: string, filePath: string): unknown {
	const withoutBom = text.replace(/^\uFEFF/, "");
	const withoutComments = stripJsonComments(withoutBom);
	const normalized = stripTrailingCommas(withoutComments);

	try {
		return JSON.parse(normalized);
	} catch (error) {
		throw new Error(
			`Could not parse ${filePath}. The file must contain valid JSON or JSON-with-comments. ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await stat(targetPath);
		return true;
	} catch {
		return false;
	}
}

async function readTextIfExists(targetPath: string): Promise<string | null> {
	try {
		return await readFile(targetPath, "utf8");
	} catch {
		return null;
	}
}

async function writeTextIfDifferent(targetPath: string, content: string): Promise<boolean> {
	const current = await readTextIfExists(targetPath);
	if (current === content) return false;

	await mkdir(path.dirname(targetPath), { recursive: true });
	await writeFile(targetPath, content, "utf8");
	return true;
}

async function readKeymapEntries(filePath: string): Promise<KeymapEntry[]> {
	const content = await readTextIfExists(filePath);
	if (content == null) {
		return [];
	}

	const parsed = parseJsonc(content, filePath);
	if (!Array.isArray(parsed)) {
		throw new Error(`${filePath} must contain a JSON array.`);
	}

	return parsed.map((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`${filePath} must contain an array of JSON objects.`);
		}
		return { ...(entry as JsonObject) };
	});
}

async function readTasksDocument(filePath: string): Promise<TasksDocument> {
	const content = await readTextIfExists(filePath);
	if (content == null) {
		return {
			kind: "array",
			tasks: [],
		};
	}

	const parsed = parseJsonc(content, filePath);
	if (Array.isArray(parsed)) {
		return {
			kind: "array",
			tasks: parsed.map((task) => {
				if (!task || typeof task !== "object" || Array.isArray(task)) {
					throw new Error(`${filePath} must contain an array of JSON task objects.`);
				}
				return { ...(task as JsonObject) };
			}),
		};
	}

	if (!parsed || typeof parsed !== "object") {
		throw new Error(`${filePath} must contain either an array of tasks or an object with a tasks array.`);
	}

	const root = { ...(parsed as JsonObject) };
	const tasksValue = root.tasks;
	if (!Array.isArray(tasksValue)) {
		throw new Error(`${filePath} must contain a top-level tasks array.`);
	}

	const tasks = tasksValue.map((task) => {
		if (!task || typeof task !== "object" || Array.isArray(task)) {
			throw new Error(`${filePath} must contain a tasks array made of JSON objects.`);
		}
		return { ...(task as JsonObject) };
	});

	return {
		kind: "object",
		root: { ...root, tasks },
		tasks,
	};
}

function toPrettyJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function isManagedBindingValue(value: unknown): boolean {
	return JSON.stringify(value) === JSON.stringify(MANAGED_BINDING_VALUE);
}

function createManagedKeymapEntry(): KeymapEntry {
	return {
		context: KEYMAP_CONTEXT,
		bindings: {
			[KEY_SEQUENCE]: MANAGED_BINDING_VALUE,
		},
	};
}

function createManagedTask(helperPath: string): TaskDefinition {
	return {
		type: "shell",
		label: TASK_LABEL,
		command: process.execPath,
		args: [helperPath],
		use_new_terminal: false,
		allow_concurrent_runs: false,
		reveal: "never",
		hide: "always",
		show_summary: false,
		show_command: false,
		save: "none",
	};
}

function removeManagedBindings(entries: KeymapEntry[]): { entries: KeymapEntry[]; removedCount: number } {
	let removedCount = 0;
	const cleanedEntries: KeymapEntry[] = [];

	for (const entry of entries) {
		const nextEntry: KeymapEntry = { ...entry };
		const bindings = entry.bindings;
		if (bindings && typeof bindings === "object" && !Array.isArray(bindings)) {
			const nextBindings = { ...bindings };
			if (isManagedBindingValue(nextBindings[KEY_SEQUENCE])) {
				delete nextBindings[KEY_SEQUENCE];
				removedCount += 1;
			}

			if (Object.keys(nextBindings).length > 0) {
				nextEntry.bindings = nextBindings;
				cleanedEntries.push(nextEntry);
				continue;
			}

			delete nextEntry.bindings;
		}

		if (nextEntry.bindings == null && Object.keys(nextEntry).length === 1 && nextEntry.context === KEYMAP_CONTEXT) {
			continue;
		}

		if (nextEntry.bindings == null && Object.keys(nextEntry).length === 0) {
			continue;
		}

		cleanedEntries.push(nextEntry);
	}

	return { entries: cleanedEntries, removedCount };
}

function countConflictingBindings(entries: KeymapEntry[]): number {
	let count = 0;
	for (const entry of entries) {
		const bindingValue = entry.bindings?.[KEY_SEQUENCE];
		if (bindingValue !== undefined && !isManagedBindingValue(bindingValue)) {
			count += 1;
		}
	}
	return count;
}

function removeManagedTasks(tasks: TaskDefinition[]): { tasks: TaskDefinition[]; removedCount: number } {
	let removedCount = 0;
	const nextTasks = tasks.filter((task) => {
		if (task.label === TASK_LABEL) {
			removedCount += 1;
			return false;
		}
		return true;
	});
	return { tasks: nextTasks, removedCount };
}

function shouldWriteTasksAsArray(doc: TasksDocument): boolean {
	if (doc.kind === "array") return true;

	const keys = Object.keys(doc.root).filter((key) => key !== "tasks");
	return keys.length === 0 || (keys.length === 1 && keys[0] === "version");
}

async function writeKeymapEntries(filePath: string, entries: KeymapEntry[]): Promise<boolean> {
	return await writeTextIfDifferent(filePath, toPrettyJson(entries));
}

async function writeTasksDocument(filePath: string, doc: TasksDocument): Promise<boolean> {
	if (doc.kind === "array") {
		return await writeTextIfDifferent(filePath, toPrettyJson(doc.tasks));
	}

	const nextRoot: JsonObject = { ...doc.root, tasks: doc.tasks };
	if (nextRoot.version == null) {
		nextRoot.version = "2.0.0";
	}
	return await writeTextIfDifferent(filePath, toPrettyJson(nextRoot));
}

function buildHelperScriptContent(): string {
	return `#!/usr/bin/env node
// Generated by pi-config /${INSTALL_COMMAND}.
// Safe to overwrite by rerunning /${INSTALL_COMMAND} and safe to remove with /${REMOVE_COMMAND}.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const selectionFile = path.join(os.homedir(), ".pi", "ide-selection.json");
const sourceFile = process.env.ZED_FILE?.trim();
const selectedText = process.env.ZED_SELECTED_TEXT ?? "";
const cursorRow = Number.parseInt(process.env.ZED_ROW ?? "", 10);

if (!sourceFile) {
  process.exit(0);
}

function countLines(text) {
  if (!text) return 0;
  const parts = text.split(/\\r?\\n/);
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return Math.max(parts.length, 1);
}

function normalizeSelectedText(text) {
  if (!text) return text;
  if (text.trim().length === 0) return text;
  return text.replace(/(?:\\r?\\n[ \t]*)+$/, "");
}

function lineForIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\\n") line += 1;
  }
  return line;
}

function bestRangeForSelection(filePath, selection, rowHint) {
  if (!selection) return null;

  let fileText;
  try {
    fileText = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const matches = [];
  let searchIndex = 0;
  const step = Math.max(selection.length, 1);
  while (searchIndex <= fileText.length) {
    const foundIndex = fileText.indexOf(selection, searchIndex);
    if (foundIndex === -1) break;
    matches.push(foundIndex);
    searchIndex = foundIndex + step;
    if (matches.length >= 200) break;
  }

  if (matches.length === 0) return null;

  const lineCount = Math.max(countLines(selection), 1);
  let bestIndex = matches[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const matchIndex of matches) {
    const startLine = lineForIndex(fileText, matchIndex);
    const distance = Number.isFinite(rowHint) ? Math.abs(startLine - rowHint) : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = matchIndex;
    }
  }

  const startLine = lineForIndex(fileText, bestIndex);
  return { startLine, endLine: startLine + lineCount - 1 };
}

const data = {
  file: sourceFile,
  ide: "zed",
  timestamp: Date.now(),
};

const normalizedSelection = normalizeSelectedText(selectedText);

if (normalizedSelection.length > 0) {
  data.selection = normalizedSelection;
  const range = bestRangeForSelection(sourceFile, normalizedSelection, cursorRow);
  if (range) {
    data.startLine = range.startLine;
    data.endLine = range.endLine;
  }
}

fs.mkdirSync(path.dirname(selectionFile), { recursive: true });
fs.writeFileSync(selectionFile, JSON.stringify(data, null, 2) + "\\n", "utf8");
`;
}

async function installZedIntegration(): Promise<InstallResult> {
	const zedConfigDir = getZedConfigDir();
	const helperPath = path.join(zedConfigDir, HELPER_FILE_NAME);
	const keymapPath = path.join(zedConfigDir, "keymap.json");
	const tasksPath = path.join(zedConfigDir, "tasks.json");

	await mkdir(zedConfigDir, { recursive: true });

	const helperChanged = await writeTextIfDifferent(helperPath, buildHelperScriptContent());

	const originalKeymap = await readKeymapEntries(keymapPath);
	const conflictingBindings = countConflictingBindings(originalKeymap);
	const cleanedKeymap = removeManagedBindings(originalKeymap).entries;
	cleanedKeymap.push(createManagedKeymapEntry());
	const keymapChanged = await writeKeymapEntries(keymapPath, cleanedKeymap);

	const tasksDocument = await readTasksDocument(tasksPath);
	const cleanedTasks = removeManagedTasks(tasksDocument.tasks).tasks;
	cleanedTasks.push(createManagedTask(helperPath));
	let tasksOutputDoc: TasksDocument;
	if (shouldWriteTasksAsArray(tasksDocument) || tasksDocument.kind === "array") {
		tasksOutputDoc = { kind: "array", tasks: cleanedTasks };
	} else {
		tasksOutputDoc = { kind: "object", root: tasksDocument.root, tasks: cleanedTasks };
	}
	const tasksChanged = await writeTasksDocument(tasksPath, tasksOutputDoc);

	return {
		helperChanged,
		keymapChanged,
		tasksChanged,
		conflictingBindings,
		zedConfigDir,
		helperPath,
		keymapPath,
		tasksPath,
	};
}

async function maybeRemoveFile(targetPath: string): Promise<boolean> {
	if (!(await pathExists(targetPath))) return false;
	await rm(targetPath, { force: true });
	return true;
}

async function maybeClearSelectionFile(): Promise<boolean> {
	const content = await readTextIfExists(SELECTION_FILE);
	if (content == null) return false;

	try {
		const parsed = JSON.parse(content) as { ide?: unknown };
		if (typeof parsed.ide === "string" && parsed.ide.toLowerCase() === "zed") {
			await rm(SELECTION_FILE, { force: true });
			return true;
		}
	} catch {
		// ignore invalid selection file
	}

	return false;
}

async function removeZedIntegration(): Promise<RemoveResult> {
	const zedConfigDir = getZedConfigDir();
	const helperPath = path.join(zedConfigDir, HELPER_FILE_NAME);
	const keymapPath = path.join(zedConfigDir, "keymap.json");
	const tasksPath = path.join(zedConfigDir, "tasks.json");

	const helperRemoved = await maybeRemoveFile(helperPath);

	let keymapChanged = false;
	if (await pathExists(keymapPath)) {
		const keymapEntries = await readKeymapEntries(keymapPath);
		const cleaned = removeManagedBindings(keymapEntries);
		if (cleaned.removedCount > 0) {
			keymapChanged = await writeKeymapEntries(keymapPath, cleaned.entries);
		}
	}

	let tasksChanged = false;
	if (await pathExists(tasksPath)) {
		const tasksDocument = await readTasksDocument(tasksPath);
		const cleaned = removeManagedTasks(tasksDocument.tasks);
		if (cleaned.removedCount > 0) {
			tasksChanged = await writeTasksDocument(
				tasksPath,
				tasksDocument.kind === "array"
					? { kind: "array", tasks: cleaned.tasks }
					: { kind: "object", root: tasksDocument.root, tasks: cleaned.tasks },
			);
		}
	}

	const selectionCleared = await maybeClearSelectionFile();

	return {
		helperRemoved,
		keymapChanged,
		tasksChanged,
		selectionCleared,
		zedConfigDir,
	};
}

function describePiSideAvailability(pi: ExtensionAPI): string {
	const hasIdeCommand = pi.getCommands().some((command) => command.name === "ide");
	if (hasIdeCommand) {
		return "Detected a pi-side /ide command, so the Zed shortcut should be usable immediately in pi.";
	}

	return "No pi-side /ide command is currently loaded. Enable npm:@pborck/pi-de or another extension that consumes ~/.pi/ide-selection.json.";
}

export default function myZedPide(pi: ExtensionAPI): void {
	pi.registerCommand(INSTALL_COMMAND, {
		description: "Install or update idempotent Zed keymap/tasks config for pi-de-style file or selection export.",
		handler: async (args, ctx) => {
			if (!validateInvocation(INSTALL_COMMAND, args, ctx)) {
				return;
			}

			const result = await installZedIntegration();
			const changed = result.helperChanged || result.keymapChanged || result.tasksChanged;
			const summary = changed
				? `Configured Zed integration in ${result.zedConfigDir}.`
				: `Zed integration is already up to date in ${result.zedConfigDir}.`;
			notify(ctx, summary, "info");
			notify(ctx, `Managed files: ${result.keymapPath}, ${result.tasksPath}, ${result.helperPath}`, "info");

			if (result.conflictingBindings > 0) {
				notify(
					ctx,
					`Found ${result.conflictingBindings} existing ${KEY_SEQUENCE_LABEL} binding(s). The managed binding is appended later, so it should take precedence without deleting earlier bindings.`,
					"warning",
				);
			}

			notify(ctx, describePiSideAvailability(pi), pi.getCommands().some((command) => command.name === "ide") ? "info" : "warning");
			notify(ctx, `Use ${KEY_SEQUENCE_LABEL} in Zed to export the current file or selection, then ${KEY_SEQUENCE_LABEL} in pi to paste the reference.`, "info");
		},
	});

	pi.registerCommand(REMOVE_COMMAND, {
		description: "Remove the Zed keymap/tasks config previously installed by /my-zed-pide-install.",
		handler: async (args, ctx) => {
			if (!validateInvocation(REMOVE_COMMAND, args, ctx)) {
				return;
			}

			const result = await removeZedIntegration();
			const changed = result.helperRemoved || result.keymapChanged || result.tasksChanged || result.selectionCleared;
			if (!changed) {
				notify(ctx, `No managed Zed integration was found in ${result.zedConfigDir}.`, "info");
				return;
			}

			notify(ctx, `Removed managed Zed integration from ${result.zedConfigDir}.`, "info");
			if (result.selectionCleared) {
				notify(ctx, `Cleared ${SELECTION_FILE} because it still pointed to Zed.`, "info");
			}
		},
	});
}
