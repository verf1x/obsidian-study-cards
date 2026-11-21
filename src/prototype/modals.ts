import { Modal, type App } from "obsidian";
import { sample, type CheckCard, type Order } from "./check";

export class SetupModal extends Modal {
  private unsubscribe?: () => void;

  constructor(app: App, private readonly section: string, private readonly readCards: () => readonly CheckCard[],
    private readonly watchCards: (listener: () => void) => () => void,
    private readonly start: string | undefined, private readonly launch: (cards: CheckCard[]) => void,
    private readonly restoreFocus: () => void) {
    super(app);
  }

  onOpen() {
    this.setTitle("Настроить свободную проверку");
    const root = this.contentEl;
    root.addClass("study-cards-prototype-modal");
    root.createEl("p", { text: this.section, cls: "study-cards-muted" });
    const form = root.createEl("form", { cls: "study-cards-setup" });
    const order = form.createEl("label", { text: "Порядок вопросов" }).createEl("select");
    order.createEl("option", { value: "standard", text: "Стандартный" });
    order.createEl("option", { value: "random", text: "Случайный" });
    const origin = form.createEl("p", { cls: "study-cards-muted", attr: { "aria-live": "polite" } });
    const count = form.createEl("label", { text: "Количество вопросов" }).createEl("input", {
      type: "number", attr: { min: "1", step: "1", required: "" },
    });
    const available = form.createEl("p", { cls: "study-cards-muted", attr: { "aria-live": "polite" } });
    const actions = form.createDiv({ cls: "study-cards-dialog-actions" });
    actions.createEl("button", { text: "Отмена", type: "button" }).onclick = () => this.close();
    const begin = actions.createEl("button", { text: "Начать проверку", type: "submit", cls: "mod-cta" });
    let requested = 20;
    count.oninput = () => {
      const value = count.valueAsNumber;
      if (Number.isInteger(value) && value > 0) requested = value;
    };
    const options = () => {
      const cards = this.readCards();
      const random = order.value === "random";
      const startIndex = this.start ? cards.findIndex(({ id }) => id === this.start) : 0;
      const maximum = random ? cards.length : startIndex < 0 ? 0 : cards.length - startIndex;
      return { cards, random, startIndex, maximum };
    };
    const update = () => {
      const { cards, random, maximum, startIndex } = options();
      count.max = String(maximum);
      count.disabled = maximum === 0;
      count.value = maximum > 0 ? String(Math.min(requested, maximum)) : "";
      const first = cards[startIndex];
      origin.textContent = random ? "Выборка из всего раздела без повторов"
        : first ? "Первый вопрос: " + first.question : this.start ? "Стартовая карточка недоступна" : "";
      available.textContent = "Доступно вопросов: " + maximum;
      begin.disabled = maximum === 0;
    };
    order.onchange = update;
    update();
    this.unsubscribe = this.watchCards(update);
    form.onsubmit = (event) => {
      event.preventDefault();
      const { cards, maximum } = options();
      const quantity = count.valueAsNumber;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > maximum) {
        update();
        return;
      }
      const selected = sample(cards, order.value as Order, quantity, this.start);
      this.close();
      this.launch(selected);
    };
  }

  onClose() {
    this.unsubscribe?.();
    this.restoreFocus();
  }
}

type Choice = { label: string; action: () => void; primary?: boolean };

export class CheckModal extends Modal {
  constructor(app: App, private readonly title: string, private readonly prompt: string,
    private readonly choices: readonly Choice[], private readonly cancel?: () => void) {
    super(app);
  }

  onOpen() {
    this.setTitle(this.title);
    this.contentEl.addClass("study-cards-prototype-modal");
    this.contentEl.createEl("p", { text: this.prompt });
    const actions = this.contentEl.createDiv({ cls: "study-cards-dialog-actions" });
    actions.createEl("button", { text: "Отмена" }).onclick = () => this.close();
    for (const choice of this.choices) {
      actions.createEl("button", { text: choice.label, cls: choice.primary ? "mod-cta" : undefined }).onclick = () => {
        this.close();
        choice.action();
      };
    }
  }

  onClose() { this.cancel?.(); }
}
