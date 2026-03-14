function takeOptionValue(args, index, flag) {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`Missing value for ${flag}.`);
	}
	return value;
}

function createDefaultOptions() {
	return {
		command: "run",
		name: null,
		base: null,
		keepClean: false,
		deleteClean: false,
		keepDirty: false,
		deleteDirty: false,
		yes: false,
		json: false,
		debug: false,
		piBin: null,
		piArgs: [],
		help: false,
	};
}

function validateMutuallyExclusive(options) {
	if (options.keepClean && options.deleteClean) {
		throw new Error("Use only one of --keep-clean or --delete-clean.");
	}

	if (options.keepDirty && options.deleteDirty) {
		throw new Error("Use only one of --keep-dirty or --delete-dirty.");
	}
}

function parseRunArgs(args, options) {
	const positionals = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		switch (arg) {
			case "--help":
			case "-h":
				options.help = true;
				break;
			case "--base":
				options.base = takeOptionValue(args, index, arg);
				index += 1;
				break;
			case "--keep-clean":
				options.keepClean = true;
				break;
			case "--delete-clean":
				options.deleteClean = true;
				break;
			case "--keep-dirty":
				options.keepDirty = true;
				break;
			case "--delete-dirty":
				options.deleteDirty = true;
				break;
			case "--yes":
				options.yes = true;
				break;
			case "--debug":
				options.debug = true;
				break;
			case "--pi-bin":
				options.piBin = takeOptionValue(args, index, arg);
				index += 1;
				break;
			default:
				if (arg.startsWith("--")) {
					throw new Error(`Unknown option: ${arg}`);
				}
				positionals.push(arg);
		}
	}

	if (positionals.length > 1) {
		throw new Error("Too many positional arguments. Expected at most one worktree name.");
	}

	options.name = positionals[0] ?? null;
	validateMutuallyExclusive(options);
}

function parseListArgs(args, options) {
	options.command = "list";
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		switch (arg) {
			case "--help":
			case "-h":
				options.help = true;
				break;
			case "--json":
				options.json = true;
				break;
			case "--debug":
				options.debug = true;
				break;
			default:
				throw new Error(`Unknown list argument: ${arg}`);
		}
	}
}

function parsePathArgs(args, options) {
	options.command = "path";
	const positionals = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		switch (arg) {
			case "--help":
			case "-h":
				options.help = true;
				break;
			case "--debug":
				options.debug = true;
				break;
			default:
				if (arg.startsWith("--")) {
					throw new Error(`Unknown path argument: ${arg}`);
				}
				positionals.push(arg);
		}
	}

	if (positionals.length !== 1 && !options.help) {
		throw new Error("The path command requires exactly one worktree name.");
	}

	options.name = positionals[0] ?? null;
}

function parseRemoveArgs(args, options) {
	options.command = "rm";
	const positionals = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		switch (arg) {
			case "--help":
			case "-h":
				options.help = true;
				break;
			case "--yes":
				options.yes = true;
				break;
			case "--debug":
				options.debug = true;
				break;
			default:
				if (arg.startsWith("--")) {
					throw new Error(`Unknown rm argument: ${arg}`);
				}
				positionals.push(arg);
		}
	}

	if (positionals.length !== 1 && !options.help) {
		throw new Error("The rm command requires exactly one worktree name.");
	}

	options.name = positionals[0] ?? null;
}

export function parseArgs(argv) {
	const options = createDefaultOptions();
	const separatorIndex = argv.indexOf("--");
	const mainArgs = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
	options.piArgs = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1);

	if (mainArgs[0] === "list") {
		parseListArgs(mainArgs.slice(1), options);
		return options;
	}

	if (mainArgs[0] === "path") {
		parsePathArgs(mainArgs.slice(1), options);
		return options;
	}

	if (mainArgs[0] === "rm") {
		parseRemoveArgs(mainArgs.slice(1), options);
		return options;
	}

	parseRunArgs(mainArgs, options);
	return options;
}

export function getHelpText() {
	return [
		"piw - git worktree wrapper for pi",
		"",
		"Usage:",
		"  piw [name] [options] [-- <pi args...>]",
		"  piw list [--json]",
		"  piw path <name>",
		"  piw rm <name> [--yes]",
		"",
		"Run options:",
		"  --base <branch>     Base branch or revision for new worktrees",
		"  --keep-clean        Keep a clean worktree after pi exits",
		"  --delete-clean      Delete a clean worktree after pi exits",
		"  --keep-dirty        Keep a dirty worktree after pi exits",
		"  --delete-dirty      Delete a dirty worktree after pi exits",
		"  --yes               Skip confirmations required by delete flags",
		"  --pi-bin <path>     Override the pi executable (or use PIW_PI_BIN)",
		"  --debug             Print extra wrapper diagnostics",
		"",
		"Notes:",
		"  - Clean auto-generated worktrees are deleted by default; clean named worktrees are kept.",
		"  - Managed branches use the prefix 'piw/'.",
		"  - Managed worktrees are stored beside the repo in '<repo>.worktrees/<name>'.",
		"  - Extra pi arguments must come after '--'.",
	].join("\n");
}
