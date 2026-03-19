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
] as const;

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
] as const;

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
] as const;

function pick<T>(values: readonly T[]): T {
	return values[randomInt(values.length)]!;
}

function makePlanId(): string {
	return `${pick(ADJECTIVES)}-${pick(PLACES)}-${pick(ANIMALS)}`;
}

export function generateFriendlyPlanId(existingIds: Iterable<string>): string {
	const existing = new Set(existingIds);

	for (let attempt = 0; attempt < 20; attempt += 1) {
		const candidate = makePlanId();
		if (!existing.has(candidate)) {
			return candidate;
		}
	}

	for (let suffix = 2; suffix < 100; suffix += 1) {
		const candidate = `${makePlanId()}-${suffix}`;
		if (!existing.has(candidate)) {
			return candidate;
		}
	}

	throw new Error("Unable to generate a unique friendly plan id.");
}
