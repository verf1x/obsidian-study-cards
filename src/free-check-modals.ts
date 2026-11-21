import { Modal, type App } from "obsidian";
import { CardPicker } from "./free-check-picker";
import { t } from "./localization";
import { message } from "./source-modals";
import { checkRange, type CheckCard, type CheckOrder, type CheckSelection } from "./free-check";

type SetupSelection = Extract<CheckSelection, { sectionId: string }>;

export class CheckSetupModal extends Modal {
  private unsubscribe?: () => void;

  constructor(app: App, private readonly section: { id: string; name: string },
    private readonly start: CheckCard | undefined, private readonly getCards: () => readonly CheckCard[],
    private readonly subscribe: (callback: () => void) => () => void,
    private readonly launch: (selection: SetupSelection) => Promise<void>) { super(app); }

  onOpen() {
    this.setTitle(t("configureFreeCheck"));
    const form = this.contentEl.createEl("form", { cls: "study-cards-form" });
    form.createEl("p", { text: this.section.name });
    const method = form.createEl("label", { text: t("checkSelectionMethod") + " " }).createEl("select");
    method.createEl("option", { value: "standard", text: t("standardOrder") });
    method.createEl("option", { value: "random", text: t("randomOrder") });
    method.createEl("option", { value: "manual", text: t("selectCheckCards") });
    const selectedMethod = () => method.value as CheckOrder | "manual";
    const ordered = form.createDiv();
    const first = ordered.createEl("p");
    const count = ordered.createEl("label", { text: t("questionCount") + " " }).createEl("input", {
      type: "number", attr: { min: "1", step: "1", required: "" },
    });
    const available = ordered.createEl("p", { attr: { "aria-live": "polite" } });
    const changeSelection = () => {
      feedback.textContent = "";
      update();
    };
    const picker = new CardPicker(form, this.start, changeSelection);
    const actions = form.createDiv({ cls: "study-cards-controls" });
    actions.createEl("button", { text: t("cancel"), attr: { type: "button" } }).onclick = () => this.close();
    const begin = actions.createEl("button", { text: t("startFreeCheck"), attr: { type: "submit" }, cls: "mod-cta" });
    const feedback = form.createDiv({ attr: { role: "status" } });
    let requested = 20;
    let saving = false;
    const update = () => {
      const cards = this.getCards();
      const selection = selectedMethod();
      ordered.hidden = selection === "manual";
      picker.root.hidden = !ordered.hidden;
      method.disabled = saving;
      if (selection === "manual") {
        count.disabled = true;
        begin.disabled = !picker.update(cards, saving) || saving;
        return;
      }
      const { offset, maximum } = checkRange(cards, selection, this.start?.id);
      count.max = String(maximum);
      count.value = maximum ? String(Math.min(requested, maximum)) : "";
      count.disabled = begin.disabled = saving || maximum === 0;
      const firstCard = cards[offset];
      first.textContent = selection === "random" ? t("wholeSectionSelection")
        : firstCard ? t("firstQuestion", { question: firstCard.question }) : t("startCardUnavailable");
      available.textContent = t("questionsAvailable", { count: maximum });
    };
    count.oninput = () => {
      if (Number.isInteger(count.valueAsNumber) && count.valueAsNumber > 0) requested = count.valueAsNumber;
    };
    method.onchange = changeSelection;
    update();
    this.unsubscribe = this.subscribe(update);
    form.onsubmit = (event) => {
      event.preventDefault();
      if (begin.disabled || !count.checkValidity()) return;
      const sectionId = this.section.id;
      const order = selectedMethod();
      const selection: SetupSelection = order === "manual"
        ? { sectionId, cardIds: picker.cardIds }
        : { sectionId, start: this.start?.id, count: count.valueAsNumber, order };
      saving = true;
      update();
      feedback.textContent = "";
      void this.launch(selection).then(() => this.close()).catch((error) => {
        saving = false;
        update();
        feedback.textContent = message(error);
      });
    };
  }

  onClose() { this.unsubscribe?.(); }
}

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
