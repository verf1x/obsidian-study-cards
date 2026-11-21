import { Modal, type App } from "obsidian";
import { sample, type CheckCard, type Order } from "./check";

export class SetupModal extends Modal {
  constructor(app: App, private readonly section: string, private readonly cards: readonly CheckCard[],
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
    const startIndex = Math.max(0, this.cards.findIndex(({ id }) => id === this.start));
    const update = () => {
      const random = order.value === "random";
      const maximum = random ? this.cards.length : this.cards.length - startIndex;
      const previous = count.valueAsNumber;
      count.max = String(maximum);
      count.value = String(Math.min(Number.isFinite(previous) && previous > 0 ? previous : 20, maximum));
      const first = this.cards[startIndex];
      origin.textContent = random ? "Выборка из всего раздела без повторов"
        : first ? "Первый вопрос: " + first.question : "";
      available.textContent = "Доступно вопросов: " + maximum;
      begin.disabled = maximum === 0;
    };
    order.onchange = update;
    update();
    form.onsubmit = (event) => {
      event.preventDefault();
      const cards = sample(this.cards, order.value as Order, count.valueAsNumber, this.start);
      if (cards.length === 0) return;
      this.close();
      this.launch(cards);
    };
  }

  onClose() { this.restoreFocus(); }
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
