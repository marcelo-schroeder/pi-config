#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function readExistingRecords(capturePath) {
	try {
		const raw = await readFile(capturePath, "utf8");
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch (error) {
		if (error?.code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

async function main() {
	const capturePath = process.env.PIW_HOOK_CAPTURE_PATH;
	if (!capturePath) {
		throw new Error("PIW_HOOK_CAPTURE_PATH is required.");
	}

	const records = await readExistingRecords(capturePath);
	const capturedEnv = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => key.startsWith("PI_WORKTREE_") || key.startsWith("PIW_HOOK_")),
	);

	records.push({
		cwd: process.cwd(),
		argv: process.argv.slice(2),
		env: capturedEnv,
	});

	await mkdir(path.dirname(capturePath), { recursive: true });
	await writeFile(capturePath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

	const exitCode = Number.parseInt(process.env.PIW_TEST_HOOK_EXIT_CODE || "0", 10);
	process.exit(Number.isNaN(exitCode) ? 0 : exitCode);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
