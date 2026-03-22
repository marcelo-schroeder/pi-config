/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
	normalizeQuestions,
	runQuestionnaireUI,
	type Question,
	type QuestionnaireResult,
} from "./ui.ts";

const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when this option is selected" }),
	label: Type.String({ description: "Concise option label shown in the selectable list" }),
	description: Type.Optional(
		Type.String({
			description: "Optional secondary text shown below the label to clarify details or tradeoffs",
		}),
	),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short tab label for multi-question flows; defaults to Q1, Q2, ...",
		}),
	),
	prompt: Type.String({ description: "Question text shown above the options" }),
	options: Type.Array(QuestionOptionSchema, {
		description: "Selectable answers for this question; keep labels concise and use descriptions for nuance",
	}),
	allowOther: Type.Optional(
		Type.Boolean({
			description:
				"Allow a free-text 'Type something' fallback when predefined options may not fully cover the user's answer (default: true)",
		}),
	),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "One or more structured questions to ask in a single questionnaire flow",
	}),
});

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

export default function questionnaire(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description: "Ask one or more structured clarification questions in interactive mode.",
		promptSnippet: "Ask one or more structured clarification questions with selectable options and optional free-text fallback",
		promptGuidelines: [
			"Prefer this tool when missing information can be captured as short structured choices instead of open-ended chat.",
			"Batch related clarifications into one questionnaire call when possible instead of asking several separate follow-up messages.",
			"Use multiple questions in one call for independent decisions such as scope, priority, constraints, or preferences.",
			"Use concise option labels and optional descriptions to explain differences or tradeoffs.",
			"Keep allowOther enabled when a custom answer may be useful; disable it when the input must be restricted to the listed options.",
			"Use normal chat instead for broad exploratory discussion, detailed explanations, or when the user needs to provide rich context.",
		],
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			const questions = normalizeQuestions(params.questions);
			const result = await runQuestionnaireUI(ctx, questions);

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: result,
				};
			}

			const answerLines = result.answers.map((answer) => {
				const questionLabel = questions.find((question) => question.id === answer.id)?.label || answer.id;
				if (answer.wasCustom) {
					return `${questionLabel}: user wrote: ${answer.label}`;
				}
				return `${questionLabel}: user selected: ${answer.index}. ${answer.label}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme) {
			const questions = (args.questions as Question[]) || [];
			const count = questions.length;
			const labels = questions.map((question) => question.label || question.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((answer) => {
				if (answer.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.id)}: ${theme.fg("muted", "(wrote) ")}${answer.label}`;
				}
				const display = answer.index ? `${answer.index}. ${answer.label}` : answer.label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.id)}: ${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
