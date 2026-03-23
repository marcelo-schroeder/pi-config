import { parseSkillBlock } from "@mariozechner/pi-coding-agent";

const SNAPSHOT_SKILL_NAME = "my-commit-changes";

interface MessageContentPartLike {
	type?: string;
	text?: string;
}

interface MessageLike {
	role?: string;
	content?: string | MessageContentPartLike[];
}

export interface SnapshotAuthorizationEntry {
	type?: string;
	message?: MessageLike;
}

function getMessageText(content: MessageLike["content"]): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}

	const textParts: string[] = [];
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string") {
			textParts.push(part.text);
		}
	}
	return textParts.join("");
}

function getLatestUserMessageText(entries: readonly SnapshotAuthorizationEntry[]): string | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message?.role !== "user") {
			continue;
		}

		const text = getMessageText(entry.message.content).trim();
		return text.length > 0 ? text : null;
	}

	return null;
}

export function isSnapshotToolAuthorizedForEntries(entries: readonly SnapshotAuthorizationEntry[]): boolean {
	const latestUserMessage = getLatestUserMessageText(entries);
	if (!latestUserMessage) {
		return false;
	}

	if (
		latestUserMessage === `/skill:${SNAPSHOT_SKILL_NAME}` ||
		latestUserMessage.startsWith(`/skill:${SNAPSHOT_SKILL_NAME} `)
	) {
		return true;
	}

	return parseSkillBlock(latestUserMessage)?.name === SNAPSHOT_SKILL_NAME;
}
