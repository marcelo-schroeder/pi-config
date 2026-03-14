import { randomInt } from "node:crypto";

const ADJECTIVES = [
	"amber",
	"brisk",
	"calm",
	"clever",
	"cobalt",
	"crisp",
	"eager",
	"gentle",
	"golden",
	"hidden",
	"lunar",
	"mellow",
	"nimble",
	"quiet",
	"rapid",
	"silver",
	"steady",
	"sunny",
	"swift",
	"vivid",
];

const PLACES = [
	"brook",
	"cinder",
	"delta",
	"forest",
	"harbor",
	"meadow",
	"mesa",
	"ocean",
	"orchard",
	"raven",
	"river",
	"shadow",
	"stone",
	"summit",
	"thicket",
	"timber",
	"valley",
	"willow",
	"winter",
	"zephyr",
];

const ANIMALS = [
	"badger",
	"falcon",
	"fox",
	"gecko",
	"heron",
	"ibis",
	"lynx",
	"martin",
	"otter",
	"owl",
	"panda",
	"quail",
	"rook",
	"seal",
	"sparrow",
	"stoat",
	"swift",
	"wolf",
	"wren",
	"yak",
];

const MANAGED_BRANCH_PREFIX = "piw/";

function sanitizeSegments(input) {
	return input
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[\s_]+/g, "-")
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function normalizeName(input) {
	if (typeof input !== "string") {
		throw new Error("Worktree name must be a string.");
	}

	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("Worktree name cannot be empty.");
	}

	if (trimmed.includes("..") || /[\\/]/.test(trimmed)) {
		throw new Error("Worktree name cannot contain path separators or '..'.");
	}

	const normalized = sanitizeSegments(trimmed);
	if (!normalized) {
		throw new Error("Worktree name must contain at least one letter or number.");
	}

	return normalized;
}

function pick(list) {
	return list[randomInt(list.length)];
}

function makeFriendlyName() {
	return `${pick(ADJECTIVES)}-${pick(PLACES)}-${pick(ANIMALS)}`;
}

export function generateFriendlyName(existingNames = new Set()) {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const name = makeFriendlyName();
		if (!existingNames.has(name)) {
			return name;
		}
	}

	for (let suffix = 2; suffix < 100; suffix += 1) {
		const name = `${makeFriendlyName()}-${suffix}`;
		if (!existingNames.has(name)) {
			return name;
		}
	}

	throw new Error("Unable to generate a unique worktree name.");
}

export function managedBranchName(name) {
	return `${MANAGED_BRANCH_PREFIX}${normalizeName(name)}`;
}

export function getManagedNameFromBranch(branchName) {
	if (!isManagedBranchName(branchName)) {
		return null;
	}

	return branchName.slice(MANAGED_BRANCH_PREFIX.length);
}

export function isManagedBranchName(branchName) {
	return typeof branchName === "string" && branchName.startsWith(MANAGED_BRANCH_PREFIX) && branchName.length > MANAGED_BRANCH_PREFIX.length;
}

export function getManagedBranchPrefix() {
	return MANAGED_BRANCH_PREFIX;
}
