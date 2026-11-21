import { Modal, type App } from "obsidian";
import { t } from "./localization";

export class CheckPrompt extends Modal {
  constructor(app: App, private readonly title: string, private readonly prompt: string,
    private readonly choices: readonly { label: string; action: () => void; primary?: boolean }[]) { super(app); }

  onOpen() {
    this.setTitle(this.title);
    this.contentEl.createEl("p", { text: this.prompt });
    const actions = this.contentEl.createDiv({ cls: "study-cards-controls" });
    actions.createEl("button", { text: t("cancel") }).onclick = () => this.close();
    for (const { label, action, primary } of this.choices) {
      actions.createEl("button", { text: label, cls: primary ? "mod-cta" : undefined }).onclick = () => {
        this.close();
        action();
      };
    }
  }
}
