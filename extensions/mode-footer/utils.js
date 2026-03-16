export const MODE_STATUS_KEYS = ["read-only-mode", "plan-mode"];

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and collapses repeated spaces.
 */
export function sanitizeStatusText(text) {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/**
 * Format token counts similar to pi's built-in footer.
 */
export function formatTokens(count) {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function getStatusMap(extensionStatuses) {
	return extensionStatuses instanceof Map ? extensionStatuses : new Map(extensionStatuses);
}

export function getModeBadgeTexts(extensionStatuses) {
	const statusMap = getStatusMap(extensionStatuses);
	return MODE_STATUS_KEYS.map((key) => statusMap.get(key))
		.filter((text) => typeof text === "string" && text.trim().length > 0)
		.map((text) => sanitizeStatusText(text));
}

export function appendModeBadges(modelInfo, extensionStatuses) {
	const modeBadges = getModeBadgeTexts(extensionStatuses);
	return modeBadges.length > 0 ? `${modelInfo} ${modeBadges.join(" ")}` : modelInfo;
}

export function getNonModeStatusTexts(extensionStatuses) {
	return Array.from(getStatusMap(extensionStatuses).entries())
		.filter(([key]) => !MODE_STATUS_KEYS.includes(key))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text));
}
