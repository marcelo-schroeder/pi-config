#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

async function main() {
	const capturePath = process.env.PIW_FAKE_PI_CAPTURE;
	if (capturePath) {
		await mkdir(path.dirname(capturePath), { recursive: true });
		const capturedEnv = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => key.startsWith("PI_WORKTREE_")),
		);
		await writeFile(
			capturePath,
			JSON.stringify(
				{
					cwd: process.cwd(),
					argv: process.argv.slice(2),
					env: capturedEnv,
				},
				null,
				2,
			),
		);
	}

	const touchPath = process.env.PIW_FAKE_PI_TOUCH;
	if (touchPath) {
		const absoluteTouchPath = path.isAbsolute(touchPath) ? touchPath : path.join(process.cwd(), touchPath);
		await mkdir(path.dirname(absoluteTouchPath), { recursive: true });
		await writeFile(absoluteTouchPath, "dirty\n");
	}

	const exitCode = Number.parseInt(process.env.PIW_FAKE_PI_EXIT_CODE || "0", 10);
	process.exit(Number.isNaN(exitCode) ? 0 : exitCode);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
