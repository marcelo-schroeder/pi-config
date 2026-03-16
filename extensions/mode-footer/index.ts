import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import { appendModeBadges, formatTokens, getModeBadgeTexts, getNonModeStatusTexts } from "./utils.js";

interface AssistantUsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: {
		total?: number;
	};
}

interface MessageEntryLike {
	type?: string;
	message?: {
		role?: string;
		usage?: AssistantUsageLike;
	};
}

function readJsonFile(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return undefined;
	}
}

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

function getAutoCompactionEnabled(cwd: string): boolean {
	let enabled = true;

	const globalSettings = readJsonFile(path.join(getAgentDir(), "settings.json")) as { compaction?: { enabled?: boolean } } | undefined;
	if (typeof globalSettings?.compaction?.enabled === "boolean") {
		enabled = globalSettings.compaction.enabled;
	}

	const projectSettings = readJsonFile(path.join(cwd, ".pi", "settings.json")) as { compaction?: { enabled?: boolean } } | undefined;
	if (typeof projectSettings?.compaction?.enabled === "boolean") {
		enabled = projectSettings.compaction.enabled;
	}

	return enabled;
}

export default function modeFooterExtension(pi: ExtensionAPI): void {
	let currentCtx: ExtensionContext | undefined;
	let currentModel: ExtensionContext["model"] = undefined;
	let autoCompactEnabled = true;

	function updateState(ctx: ExtensionContext): void {
		currentCtx = ctx;
		currentModel = ctx.model;
		autoCompactEnabled = getAutoCompactionEnabled(ctx.cwd);
	}

	function installFooter(ctx: ExtensionContext): void {
		updateState(ctx);
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					const activeCtx = currentCtx ?? ctx;
					const model = currentModel ?? activeCtx.model;

					let totalInput = 0;
					let totalOutput = 0;
					let totalCacheRead = 0;
					let totalCacheWrite = 0;
					let totalCost = 0;

					for (const entry of activeCtx.sessionManager.getEntries() as MessageEntryLike[]) {
						if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
						const usage = entry.message.usage;
						totalInput += usage?.input ?? 0;
						totalOutput += usage?.output ?? 0;
						totalCacheRead += usage?.cacheRead ?? 0;
						totalCacheWrite += usage?.cacheWrite ?? 0;
						totalCost += usage?.cost?.total ?? 0;
					}

					const contextUsage = activeCtx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

					let pwd = activeCtx.cwd;
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) {
						pwd = `~${pwd.slice(home.length)}`;
					}

					const branch = footerData.getGitBranch();
					if (branch) {
						pwd = `${pwd} (${branch})`;
					}

					const sessionName = activeCtx.sessionManager.getSessionName();
					if (sessionName) {
						pwd = `${pwd} • ${sessionName}`;
					}

					const statsParts: string[] = [];
					if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
					if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
					if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
					if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

					const usingSubscription = model ? activeCtx.modelRegistry.isUsingOAuth(model) : false;
					if (totalCost || usingSubscription) {
						statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
					}

					const autoIndicator = autoCompactEnabled ? " (auto)" : "";
					const contextPercentDisplay =
						contextPercent === "?"
							? `?/${formatTokens(contextWindow)}${autoIndicator}`
							: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
					let contextPercentStr = contextPercentDisplay;
					if (contextPercentValue > 90) {
						contextPercentStr = theme.fg("error", contextPercentDisplay);
					} else if (contextPercentValue > 70) {
						contextPercentStr = theme.fg("warning", contextPercentDisplay);
					}
					statsParts.push(contextPercentStr);

					let statsLeft = statsParts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					const modelName = model?.id || "no-model";
					let rightSideWithoutProvider = modelName;
					if (model?.reasoning) {
						const thinkingLevel = pi.getThinkingLevel() || "off";
						rightSideWithoutProvider =
							thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
					}

					const extensionStatuses = footerData.getExtensionStatuses();
					const modeBadges = getModeBadgeTexts(extensionStatuses).join(" ");
					const modeSuffix = modeBadges ? ` ${modeBadges}` : "";

					let modelInfo = rightSideWithoutProvider;
					if (footerData.getAvailableProviderCount() > 1 && model) {
						const candidateModelInfo = `(${model.provider}) ${rightSideWithoutProvider}`;
						const candidateRightSide = `${candidateModelInfo}${modeSuffix}`;
						if (statsLeftWidth + 2 + visibleWidth(candidateRightSide) <= width) {
							modelInfo = candidateModelInfo;
						}
					}

					const rightSide = appendModeBadges(modelInfo, extensionStatuses);
					const rightSideWidth = visibleWidth(rightSide);
					const minPadding = 2;
					const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

					let statsLine: string;
					if (totalNeeded <= width) {
						const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
						statsLine = statsLeft + padding + rightSide;
					} else {
						const availableForRight = width - statsLeftWidth - minPadding;
						if (availableForRight > 0) {
							const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
							const truncatedRightWidth = visibleWidth(truncatedRight);
							const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
							statsLine = statsLeft + padding + truncatedRight;
						} else {
							statsLine = statsLeft;
						}
					}

					const dimStatsLeft = theme.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length);
					const dimRemainder = theme.fg("dim", remainder);
					const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
					const lines = [pwdLine, dimStatsLeft + dimRemainder];

					const remainingStatuses = getNonModeStatusTexts(extensionStatuses);
					if (remainingStatuses.length > 0) {
						const statusLine = remainingStatuses.join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		installFooter(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		installFooter(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		currentCtx = ctx;
		currentModel = event.model;
		autoCompactEnabled = getAutoCompactionEnabled(ctx.cwd);
	});
}
