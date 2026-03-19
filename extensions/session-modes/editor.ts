import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";

interface SessionModesEditorOptions {
	onCycleMode: () => void;
}

export class SessionModesEditor extends CustomEditor {
	private readonly onCycleMode: () => void;

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		options: SessionModesEditorOptions,
	) {
		super(tui, theme, keybindings);
		this.onCycleMode = options.onCycleMode;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.shift("tab"))) {
			this.onCycleMode();
			return;
		}

		if (matchesKey(data, Key.ctrlAlt("t"))) {
			const actionHandlers = (this as unknown as { actionHandlers?: Map<string, () => void> }).actionHandlers;
			actionHandlers?.get("cycleThinkingLevel")?.();
			return;
		}

		super.handleInput(data);
	}
}
