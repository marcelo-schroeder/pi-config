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
	const numericShortcutDelayMs = 700;

	return await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
		let currentTab = 0;
		let optionIndex = 0;
		let inputMode = false;
		let inputQuestionId: string | null = null;
		let numberBuffer = "";
		let numberBufferTimer: ReturnType<typeof setTimeout> | null = null;
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

		function clearNumberBuffer(shouldRefresh = false): void {
			const hadBuffer = numberBuffer.length > 0;
			if (numberBufferTimer) {
				clearTimeout(numberBufferTimer);
				numberBufferTimer = null;
			}
			numberBuffer = "";
			if (hadBuffer && shouldRefresh) {
				refresh();
			}
		}

		function submit(cancelled: boolean): void {
			clearNumberBuffer(false);
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

		function bufferedOptionIndexForQuestion(question: Question | undefined): number | undefined {
			if (!question || numberBuffer.length === 0 || numberBuffer.startsWith("0")) return undefined;
			const parsed = Number.parseInt(numberBuffer, 10);
			const options = optionsForQuestion(question);
			if (!Number.isInteger(parsed) || parsed < 1 || parsed > options.length) return undefined;
			return parsed - 1;
		}

		function syncSelectionToCurrentQuestion(): void {
			optionIndex = currentTab < questions.length ? selectedOptionIndexForQuestion(currentQuestion()) : 0;
		}

		function allAnswered(): boolean {
			return questions.every((question) => answers.has(question.id));
		}

		function hasLongerValidNumberPrefix(prefix: string, maxOptionNumber: number): boolean {
			if (prefix.length === 0) return false;
			for (let value = 1; value <= maxOptionNumber; value += 1) {
				const optionNumber = `${value}`;
				if (optionNumber.startsWith(prefix) && optionNumber !== prefix) {
					return true;
				}
			}
			return false;
		}

		function scheduleNumberBufferCommit(): void {
			if (numberBufferTimer) {
				clearTimeout(numberBufferTimer);
			}
			numberBufferTimer = setTimeout(() => {
				numberBufferTimer = null;
				commitNumberBuffer();
			}, numericShortcutDelayMs);
		}

		function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number): void {
			answers.set(questionId, { id: questionId, value, label, wasCustom, index });
		}

		function activateOption(index: number): void {
			clearNumberBuffer(false);
			const question = currentQuestion();
			const options = currentOptions();
			if (!question || index < 0 || index >= options.length) return;
			optionIndex = index;
			const option = options[index];
			if (option.isOther) {
				const existingAnswer = answerForQuestion(question);
				inputMode = true;
				inputQuestionId = question.id;
				editor.setText(existingAnswer?.wasCustom ? existingAnswer.value : "");
				refresh();
				return;
			}
			saveAnswer(question.id, option.value, option.label, false, index + 1);
			advanceAfterAnswer();
		}

		function commitNumberBuffer(): boolean {
			const question = currentQuestion();
			const bufferedIndex = bufferedOptionIndexForQuestion(question);
			const hadBuffer = numberBuffer.length > 0;
			clearNumberBuffer(false);
			if (bufferedIndex === undefined) {
				if (hadBuffer) {
					refresh();
				}
				return false;
			}
			activateOption(bufferedIndex);
			return true;
		}

		function handleNumericShortcut(data: string): boolean {
			if (!/^\d$/.test(data) || currentTab === questions.length || inputMode) return false;
			const question = currentQuestion();
			if (!question) return false;
			if (numberBuffer.length === 0 && data === "0") return false;

			const nextBuffer = `${numberBuffer}${data}`;
			if (nextBuffer.startsWith("0")) {
				clearNumberBuffer(true);
				return true;
			}

			const options = optionsForQuestion(question);
			const parsed = Number.parseInt(nextBuffer, 10);
			if (!Number.isInteger(parsed) || parsed < 1 || parsed > options.length) {
				clearNumberBuffer(true);
				return true;
			}

			numberBuffer = nextBuffer;
			const isAmbiguous = hasLongerValidNumberPrefix(numberBuffer, options.length);
			if (isAmbiguous) {
				scheduleNumberBufferCommit();
				refresh();
				return true;
			}

			activateOption(parsed - 1);
			return true;
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

			if (handleNumericShortcut(data)) {
				return;
			}

			if (numberBuffer.length > 0 && matchesKey(data, Key.enter)) {
				commitNumberBuffer();
				return;
			}

			if (isMulti) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					clearNumberBuffer(false);
					currentTab = (currentTab + 1) % totalTabs;
					syncSelectionToCurrentQuestion();
					refresh();
					return;
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					clearNumberBuffer(false);
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
				clearNumberBuffer(false);
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				clearNumberBuffer(false);
				optionIndex = Math.min(options.length - 1, optionIndex + 1);
				refresh();
				return;
			}

			if (matchesKey(data, Key.enter) && question) {
				activateOption(optionIndex);
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
			const bufferedOptionIndex = bufferedOptionIndexForQuestion(question);
			const visibleOptionIndex = bufferedOptionIndex ?? optionIndex;
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
					const selected = index === visibleOptionIndex;
					const other = option.isOther === true;
					const otherHasSavedAnswer = other && answer?.wasCustom;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const color = selected ? "accent" : "text";
					const label =
						other && (inputMode || otherHasSavedAnswer) ? `${index + 1}. ${option.label} ✎` : `${index + 1}. ${option.label}`;
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
				if (numberBuffer.length > 0 && currentTab !== questions.length && question) {
					const bufferedOption = bufferedOptionIndex !== undefined ? options[bufferedOptionIndex] : undefined;
					const suffix = bufferedOption ? ` → ${bufferedOptionIndex! + 1}. ${bufferedOption.label}` : "";
					add(theme.fg("muted", " Number: ") + theme.fg("accent", numberBuffer) + theme.fg("dim", suffix));
				}
				const help =
					currentTab === questions.length
						? isMulti
							? " Tab/←→ navigate • Enter confirm • Esc cancel"
							: " Enter confirm • Esc cancel"
						: isMulti
							? " Type number to answer • Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
							: " Type number to answer • ↑↓ navigate • Enter select • Esc cancel";
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
