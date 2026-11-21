import { checkRange, type CheckCard, type CheckOrder, type CheckSelection } from "./free-check";
import { CardPicker } from "./free-check-picker";
import { t } from "./localization";
import { message } from "./source-modals";

type SetupSelection = Extract<CheckSelection, { sectionId: string }>;
type Method = CheckOrder | "manual";

const methods = { random: "randomOrder", standard: "standardOrder", manual: "selectCheckCards" } as const;

export class FreeCheckSetup {
  readonly root: HTMLFormElement;
  private readonly heading: HTMLHeadingElement;
  private readonly methodFields: HTMLFieldSetElement;
  private readonly ordered: HTMLElement;
  private readonly first: HTMLElement;
  private readonly count: HTMLInputElement;
  private readonly available: HTMLElement;
  private readonly picker: CardPicker;
  private readonly cancel: HTMLButtonElement;
  private readonly begin: HTMLButtonElement;
  private readonly feedback: HTMLElement;
  private readonly storageStatus: HTMLElement;
  private method: Method;
  private requested: number;
  private maximum = -1;
  private saving = false;
  private readOnly = false;
  private storageSaving = false;

  constructor(parent: HTMLElement, private readonly section: { id: string; name: string },
    private readonly start: CheckCard | undefined, introductory: boolean,
    private readonly getCards: () => readonly CheckCard[],
    close: () => void, private readonly launch: (selection: SetupSelection) => Promise<void>) {
    this.method = introductory ? "random" : "standard";
    this.requested = introductory ? 5 : 20;
    this.root = parent.createEl("form", { cls: "study-cards-check-setup" });
    const header = this.root.createDiv({ cls: "study-cards-setup-header" });
    this.heading = header.createEl("h2", { text: t("configureFreeCheck"), attr: { tabindex: "-1" } });
    header.createEl("p", { text: section.name });
    this.methodFields = this.root.createEl("fieldset", { cls: "study-cards-setup-methods" });
    this.methodFields.setAttribute("aria-label", t("checkSelectionMethod"));
    const choices = this.methodFields.createDiv({ cls: "study-cards-segmented" });
    for (const [method, name] of Object.entries(methods) as [Method, typeof methods[Method]][]) {
      const label = choices.createEl("label");
      const input = label.createEl("input", { type: "radio", attr: { name: "method", value: method } });
      input.checked = this.method === method;
      input.onchange = () => {
        this.method = method;
        this.feedback.textContent = "";
        this.update();
      };
      label.createSpan({ text: t(name) });
    }
    this.ordered = this.root.createDiv({ cls: "study-cards-setup-ordered" });
    this.count = this.ordered.createEl("label", { text: t("questionCount") + " " }).createEl("input", {
      type: "number", attr: { min: "1", step: "1", required: "", inputmode: "numeric" },
    });
    this.count.oninput = () => {
      if (Number.isInteger(this.count.valueAsNumber) && this.count.valueAsNumber > 0) {
        this.requested = this.count.valueAsNumber;
      }
    };
    this.first = this.ordered.createEl("p");
    this.available = this.ordered.createEl("p", { attr: { "aria-live": "polite" } });

    const footer = this.root.createDiv({ cls: "study-cards-setup-footer" });
    this.feedback = footer.createDiv({ attr: { role: "status" } });
    this.storageStatus = footer.createDiv({ attr: { role: "status" } });
    const actions = footer.createDiv({ cls: "study-cards-setup-actions" });
    const summary = actions.createDiv();
    const buttons = actions.createDiv({ cls: "study-cards-controls study-cards-setup-buttons" });
    this.picker = new CardPicker(this.root, { summary, buttons }, start, () => {
      this.feedback.textContent = "";
      this.update();
    });
    footer.before(this.picker.root);
    this.cancel = buttons.createEl("button", { text: t("cancel"), cls: "study-cards-quiet-button", attr: { type: "button" } });
    this.cancel.onclick = close;
    this.begin = buttons.createEl("button", { text: t("startFreeCheck"), attr: { type: "submit" }, cls: "mod-cta" });
    this.root.onsubmit = (event) => {
      event.preventDefault();
      if (!this.begin.disabled) void this.submit();
    };
    this.update();
  }

  focus() { this.heading.focus({ preventScroll: true }); }

  refresh(readOnly: boolean, saving: boolean) {
    this.readOnly = readOnly;
    this.storageSaving = saving;
    this.storageStatus.textContent = readOnly ? t("currentlyReadOnly") : saving ? t("savingStudyData") : "";
    this.update();
  }

  private update() {
    const cards = this.getCards();
    const method = this.method;
    const manual = method === "manual";
    this.ordered.hidden = manual;
    this.picker.setVisible(manual);
    this.methodFields.disabled = this.cancel.disabled = this.saving;
    const blocked = this.saving || this.readOnly || this.storageSaving;
    if (manual) {
      this.count.disabled = true;
      this.begin.disabled = !this.picker.update(cards, this.saving) || blocked;
      return;
    }
    const { offset, maximum } = checkRange(cards, method, this.start?.id);
    this.count.max = String(maximum);
    if (this.maximum !== maximum) {
      this.count.value = maximum ? String(Math.min(this.requested, maximum)) : "";
    }
    this.maximum = maximum;
    this.count.disabled = this.saving || maximum === 0;
    this.begin.disabled = blocked || maximum === 0;
    const firstCard = cards[offset];
    this.first.textContent = method === "random" ? t("wholeSectionSelection")
      : firstCard ? t("firstQuestion", { question: firstCard.question }) : t("startCardUnavailable");
    this.available.textContent = t("questionsAvailable", { count: maximum });
  }

  private async submit() {
    const sectionId = this.section.id;
    const order = this.method;
    const selection: SetupSelection = order === "manual"
      ? { sectionId, cardIds: this.picker.cardIds }
      : { sectionId, start: this.start?.id, count: this.count.valueAsNumber, order };
    this.saving = true;
    this.update();
    this.feedback.textContent = "";
    try {
      await this.launch(selection);
    } catch (error) {
      this.saving = false;
      this.update();
      this.feedback.textContent = message(error);
      (this.begin.disabled ? this.cancel : this.begin).focus({ preventScroll: true });
    }
  }
}
