import { Modal, type App } from "obsidian";
import { message } from "./source-modals";
import { checkRange, type CheckCard, type CheckSelection } from "./free-check";

type OrderedSelection = Extract<CheckSelection, { order: string }>;

export class CheckSetupModal extends Modal {
  private unsubscribe?: () => void;

  constructor(app: App, private readonly section: { id: string; name: string },
    private readonly start: string | undefined, private readonly getCards: () => readonly CheckCard[],
    private readonly subscribe: (callback: () => void) => () => void,
    private readonly launch: (selection: OrderedSelection) => Promise<void>) { super(app); }

  onOpen() {
    this.setTitle("Настроить свободную проверку");
    const form = this.contentEl.createEl("form", { cls: "study-cards-form" });
    form.createEl("p", { text: this.section.name });
    const order = form.createEl("label", { text: "Порядок вопросов " }).createEl("select");
    order.createEl("option", { value: "standard", text: "Стандартный" });
    order.createEl("option", { value: "random", text: "Случайный" });
    const first = form.createEl("p");
    const count = form.createEl("label", { text: "Количество вопросов " }).createEl("input", {
      type: "number", attr: { min: "1", step: "1", required: "" },
    });
    const available = form.createEl("p", { attr: { "aria-live": "polite" } });
    const actions = form.createDiv({ cls: "study-cards-controls" });
    actions.createEl("button", { text: "Отмена", type: "button" }).onclick = () => this.close();
    const begin = actions.createEl("button", { text: "Начать проверку", type: "submit", cls: "mod-cta" });
    const feedback = form.createEl("p", { attr: { role: "status" } });
    let requested = 20;
    let saving = false;
    const update = () => {
      const cards = this.getCards();
      const random = order.value === "random";
      const { offset, maximum } = checkRange(cards, random ? "random" : "standard", this.start);
      count.max = String(maximum);
      count.value = maximum ? String(Math.min(requested, maximum)) : "";
      count.disabled = begin.disabled = saving || maximum === 0;
      order.disabled = saving;
      first.textContent = random ? "Выборка из всего раздела"
        : cards[offset] ? "Первый вопрос: " + cards[offset].question : "Стартовая карточка недоступна";
      available.textContent = "Доступно вопросов: " + maximum;
    };
    count.oninput = () => {
      if (Number.isInteger(count.valueAsNumber) && count.valueAsNumber > 0) requested = count.valueAsNumber;
    };
    order.onchange = update;
    update();
    this.unsubscribe = this.subscribe(update);
    form.onsubmit = (event) => {
      event.preventDefault();
      if (begin.disabled || !count.checkValidity()) return;
      const selection: OrderedSelection = {
        sectionId: this.section.id, start: this.start, count: count.valueAsNumber,
        order: order.value === "random" ? "random" : "standard",
      };
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
    actions.createEl("button", { text: "Отмена" }).onclick = () => this.close();
    for (const { label, action, primary } of this.choices) {
      actions.createEl("button", { text: label, cls: primary ? "mod-cta" : undefined }).onclick = () => {
        this.close();
        action();
      };
    }
  }
}
