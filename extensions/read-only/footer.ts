import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

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

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
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

export function installReadOnlyFooter(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	readOnlyEnabled: boolean,
): void {
	if (!ctx.hasUI) return;

	const modeBadge = readOnlyEnabled ? "🔒 read-only" : undefined;
	const autoCompactEnabled = getAutoCompactionEnabled(ctx.cwd);

	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: unsubscribe,
			invalidate() {},
			render(width: number): string[] {
				const model = ctx.model;

				let totalInput = 0;
				let totalOutput = 0;
				let totalCacheRead = 0;
				let totalCacheWrite = 0;
				let totalCost = 0;

				for (const entry of ctx.sessionManager.getEntries() as MessageEntryLike[]) {
					if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
					const usage = entry.message.usage;
					totalInput += usage?.input ?? 0;
					totalOutput += usage?.output ?? 0;
					totalCacheRead += usage?.cacheRead ?? 0;
					totalCacheWrite += usage?.cacheWrite ?? 0;
					totalCost += usage?.cost?.total ?? 0;
				}

				const contextUsage = ctx.getContextUsage();
				const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
				const contextPercentValue = contextUsage?.percent ?? 0;
				const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

				let pwd = ctx.cwd;
				const home = process.env.HOME || process.env.USERPROFILE;
				if (home && pwd.startsWith(home)) {
					pwd = `~${pwd.slice(home.length)}`;
				}

				const branch = footerData.getGitBranch();
				if (branch) {
					pwd = `${pwd} (${branch})`;
				}

				const sessionName = ctx.sessionManager.getSessionName();
				if (sessionName) {
					pwd = `${pwd} • ${sessionName}`;
				}

				const statsParts: string[] = [];
				if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
				if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
				if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
				if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

				const usingSubscription = model ? ctx.modelRegistry.isUsingOAuth(model) : false;
				if (totalCost || usingSubscription) {
					statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
				}

				const autoIndicator = autoCompactEnabled ? " (auto)" : "";
				const contextPercentDisplay =
					contextPercent === "?"
						? `?/${formatTokens(contextWindow)}${autoIndicator}`
						: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
				let contextPercentText = contextPercentDisplay;
				if (contextPercentValue > 90) {
					contextPercentText = theme.fg("error", contextPercentDisplay);
				} else if (contextPercentValue > 70) {
					contextPercentText = theme.fg("warning", contextPercentDisplay);
				}
				statsParts.push(contextPercentText);

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

				let modelInfo = rightSideWithoutProvider;
				const modeSeparator = modeBadge ? " • " : "";
				const modeSuffix = modeBadge ? `${modeSeparator}${modeBadge}` : "";
				if (footerData.getAvailableProviderCount() > 1 && model) {
					const candidateModelInfo = `(${model.provider}) ${rightSideWithoutProvider}`;
					const candidateRightSide = `${candidateModelInfo}${modeSuffix}`;
					if (statsLeftWidth + 2 + visibleWidth(candidateRightSide) <= width) {
						modelInfo = candidateModelInfo;
					}
				}

				const styledModelInfo = theme.fg("dim", modelInfo);
				const styledModeSuffix = modeBadge
					? `${theme.fg("dim", modeSeparator)}${theme.fg("warning", modeBadge)}`
					: "";
				const rightSide = `${styledModelInfo}${styledModeSuffix}`;
				const rightSideWidth = visibleWidth(`${modelInfo}${modeSuffix}`);
				const minPadding = 2;
				const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
				const dimStatsLeft = theme.fg("dim", statsLeft);

				let statsLine: string;
				if (totalNeeded <= width) {
					const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
					statsLine = dimStatsLeft + padding + rightSide;
				} else {
					const availableForRight = width - statsLeftWidth - minPadding;
					if (availableForRight > 0) {
						let truncatedRight = truncateToWidth(rightSide, availableForRight, "");
						if (styledModeSuffix) {
							const modeSuffixWidth = visibleWidth(modeSuffix);
							if (availableForRight >= modeSuffixWidth) {
								const availableForModelInfo = Math.max(0, availableForRight - modeSuffixWidth);
								const truncatedModelInfo =
									availableForModelInfo > 0 ? truncateToWidth(styledModelInfo, availableForModelInfo, "") : "";
								truncatedRight = `${truncatedModelInfo}${styledModeSuffix}`;
							}
						}
						const truncatedRightWidth = visibleWidth(truncatedRight);
						const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
						statsLine = dimStatsLeft + padding + truncatedRight;
					} else {
						statsLine = dimStatsLeft;
					}
				}

				const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
				const lines = [pwdLine, statsLine];

				const remainingStatuses = Array.from(footerData.getExtensionStatuses().values())
					.filter((text): text is string => typeof text === "string" && text.trim().length > 0)
					.map((text) => sanitizeStatusText(text));
				if (remainingStatuses.length > 0) {
					const statusLine = remainingStatuses.join(" ");
					lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
				}

				return lines;
			},
		};
	});
}
