import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

export interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

export interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
}

export interface Answer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

export interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

export function normalizeQuestions(
	questions: Array<{
		id: string;
		label?: string;
		prompt: string;
		options: QuestionOption[];
		allowOther?: boolean;
	}>,
): Question[] {
	return questions.map((question, index) => ({
		...question,
		label: question.label || `Q${index + 1}`,
		allowOther: question.allowOther !== false,
	}));
}

export async function runQuestionnaireUI(
	ctx: ExtensionContext,
	questions: Question[],
): Promise<QuestionnaireResult> {
	if (!ctx.hasUI) {
		return { questions, answers: [], cancelled: true };
	}

	const isMulti = questions.length > 1;
	const totalTabs = questions.length + 1;

	return await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
		let currentTab = 0;
		let optionIndex = 0;
		let inputMode = false;
		let inputQuestionId: string | null = null;
		let cachedLines: string[] | undefined;
		const answers = new Map<string, Answer>();

		const editorTheme: EditorTheme = {
			borderColor: (text) => theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		};
		const editor = new Editor(tui, editorTheme);

		function refresh(): void {
			cachedLines = undefined;
			tui.requestRender();
		}

		function submit(cancelled: boolean): void {
			done({ questions, answers: Array.from(answers.values()), cancelled });
		}

		function currentQuestion(): Question | undefined {
			return questions[currentTab];
		}

		function optionsForQuestion(question: Question | undefined): RenderOption[] {
			if (!question) return [];
			const options: RenderOption[] = [...question.options];
			if (question.allowOther) {
				options.push({ value: "__other__", label: "Type something.", isOther: true });
			}
			return options;
		}

		function currentOptions(): RenderOption[] {
			return optionsForQuestion(currentQuestion());
		}

		function answerForQuestion(question: Question | undefined): Answer | undefined {
			return question ? answers.get(question.id) : undefined;
		}

		function selectedOptionIndexForQuestion(question: Question | undefined): number {
			if (!question) return 0;
			const answer = answerForQuestion(question);
			if (!answer) return 0;
			if (answer.wasCustom) {
				return question.allowOther ? question.options.length : 0;
			}
			if (answer.index !== undefined) {
				const maxIndex = Math.max(0, optionsForQuestion(question).length - 1);
				return Math.max(0, Math.min(answer.index - 1, maxIndex));
			}
			const matchedIndex = question.options.findIndex((option) => option.value === answer.value);
			return matchedIndex >= 0 ? matchedIndex : 0;
		}

		function syncSelectionToCurrentQuestion(): void {
			optionIndex = currentTab < questions.length ? selectedOptionIndexForQuestion(currentQuestion()) : 0;
		}

		function allAnswered(): boolean {
			return questions.every((question) => answers.has(question.id));
		}

		function advanceAfterAnswer(): void {
			if (!isMulti) {
				submit(false);
				return;
			}
			if (currentTab < questions.length - 1) {
				currentTab += 1;
			} else {
				currentTab = questions.length;
			}
			syncSelectionToCurrentQuestion();
			refresh();
		}

		function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number): void {
			answers.set(questionId, { id: questionId, value, label, wasCustom, index });
		}

		editor.onSubmit = (value) => {
			if (!inputQuestionId) return;
			const trimmed = value.trim() || "(no response)";
			saveAnswer(inputQuestionId, trimmed, trimmed, true);
			inputMode = false;
			inputQuestionId = null;
			editor.setText("");
			advanceAfterAnswer();
		};

		function handleInput(data: string): void {
			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			const question = currentQuestion();
			const options = currentOptions();

			if (isMulti) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					currentTab = (currentTab + 1) % totalTabs;
					syncSelectionToCurrentQuestion();
					refresh();
					return;
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					currentTab = (currentTab - 1 + totalTabs) % totalTabs;
					syncSelectionToCurrentQuestion();
					refresh();
					return;
				}
			}

			if (currentTab === questions.length) {
				if (matchesKey(data, Key.enter) && allAnswered()) {
					submit(false);
				} else if (matchesKey(data, Key.escape)) {
					submit(true);
				}
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(options.length - 1, optionIndex + 1);
				refresh();
				return;
			}

			if (matchesKey(data, Key.enter) && question) {
				const option = options[optionIndex];
				if (option.isOther) {
					const existingAnswer = answerForQuestion(question);
					inputMode = true;
					inputQuestionId = question.id;
					editor.setText(existingAnswer?.wasCustom ? existingAnswer.value : "");
					refresh();
					return;
				}
				saveAnswer(question.id, option.value, option.label, false, optionIndex + 1);
				advanceAfterAnswer();
				return;
			}

			if (matchesKey(data, Key.escape)) {
				submit(true);
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const lines: string[] = [];
			const question = currentQuestion();
			const answer = answerForQuestion(question);
			const options = currentOptions();
			const add = (text: string): void => {
				lines.push(truncateToWidth(text, width));
			};

			add(theme.fg("accent", "─".repeat(width)));

			if (isMulti) {
				const tabs: string[] = ["← "];
				for (let index = 0; index < questions.length; index += 1) {
					const active = index === currentTab;
					const answered = answers.has(questions[index].id);
					const label = questions[index].label;
					const box = answered ? "■" : "□";
					const color = answered ? "success" : "muted";
					const text = ` ${box} ${label} `;
					const styled = active ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
					tabs.push(`${styled} `);
				}
				const canSubmit = allAnswered();
				const submitTabActive = currentTab === questions.length;
				const submitText = " ✓ Submit ";
				const submitStyled = submitTabActive
					? theme.bg("selectedBg", theme.fg("text", submitText))
					: theme.fg(canSubmit ? "success" : "dim", submitText);
				tabs.push(`${submitStyled} →`);
				add(` ${tabs.join("")}`);
				lines.push("");
			}

			function renderOptions(): void {
				for (let index = 0; index < options.length; index += 1) {
					const option = options[index];
					const selected = index === optionIndex;
					const other = option.isOther === true;
					const otherHasSavedAnswer = other && answer?.wasCustom;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const color = selected ? "accent" : "text";
					const label = other && (inputMode || otherHasSavedAnswer) ? `${index + 1}. ${option.label} ✎` : `${index + 1}. ${option.label}`;
					add(prefix + theme.fg(color, label));
					if (option.description) {
						add(`     ${theme.fg("muted", option.description)}`);
					}
					if (otherHasSavedAnswer && !inputMode) {
						add(`     ${theme.fg("muted", "Saved answer: ")}${theme.fg("text", answer.label)}`);
					}
				}
			}

			if (inputMode && question) {
				add(theme.fg("text", ` ${question.prompt}`));
				lines.push("");
				renderOptions();
				lines.push("");
				add(theme.fg("muted", " Your answer:"));
				for (const line of editor.render(width - 2)) {
					add(` ${line}`);
				}
				lines.push("");
				add(theme.fg("dim", " Enter to submit • Esc to cancel"));
			} else if (currentTab === questions.length) {
				add(theme.fg("accent", theme.bold(" Ready to submit")));
				lines.push("");
				for (const item of questions) {
					const answer = answers.get(item.id);
					if (!answer) continue;
					const prefix = answer.wasCustom ? "(wrote) " : "";
					add(`${theme.fg("muted", ` ${item.label}: `)}${theme.fg("text", prefix + answer.label)}`);
				}
				lines.push("");
				if (allAnswered()) {
					add(theme.fg("success", " Press Enter to submit"));
				} else {
					const missing = questions
						.filter((item) => !answers.has(item.id))
						.map((item) => item.label)
						.join(", ");
					add(theme.fg("warning", ` Unanswered: ${missing}`));
				}
			} else if (question) {
				add(theme.fg("text", ` ${question.prompt}`));
				lines.push("");
				renderOptions();
			}

			lines.push("");
			if (!inputMode) {
				const help = isMulti
					? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
					: " ↑↓ navigate • Enter select • Esc cancel";
				add(theme.fg("dim", help));
			}
			add(theme.fg("accent", "─".repeat(width)));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}
