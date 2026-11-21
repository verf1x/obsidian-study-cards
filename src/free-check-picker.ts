import type { CheckCard } from "./free-check";
import { t } from "./localization";

type CardLabel = Pick<CheckCard, "question" | "path">;

export class CardPicker {
  readonly root: HTMLFieldSetElement;
  private readonly selected = new Map<string, CardLabel>();
  private readonly search: HTMLInputElement;
  private readonly allButton: HTMLButtonElement;
  private readonly selectedButton: HTMLButtonElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly count: HTMLElement;
  private readonly warning: HTMLElement;
  private readonly list: HTMLElement;
  private selectedOnly = false;

  constructor(root: HTMLElement, actions: { summary: HTMLElement; buttons: HTMLElement },
    start: CheckCard | undefined, private readonly onChange: () => void) {
    if (start) this.selected.set(start.id, start);
    this.root = root.createEl("fieldset", { cls: "study-cards-picker", attr: { "aria-label": t("selectCheckCards") } });
    const tools = this.root.createDiv({ cls: "study-cards-picker-tools" });
    this.search = tools.createEl("input", {
      type: "search", placeholder: t("searchCheckCards"), attr: { "aria-label": t("searchCheckCards") },
    });
    this.search.oninput = onChange;
    this.search.onkeydown = (event) => { if (event.key === "Enter") event.preventDefault(); };
    const filter = tools.createDiv({ cls: "study-cards-segmented" });
    this.allButton = filter.createEl("button", { text: t("allCheckCards"), attr: { type: "button" } });
    this.selectedButton = filter.createEl("button", { text: t("selectedCheckCards"), attr: { type: "button" } });
    this.allButton.onclick = () => this.filter(false);
    this.selectedButton.onclick = () => this.filter(true);
    this.count = actions.summary.createDiv({ cls: "study-cards-picker-count", attr: { role: "status" } });
    this.clearButton = actions.buttons.createEl("button", { text: t("clearCheckSelection"), cls: "study-cards-quiet-button",
      attr: { type: "button" } });
    this.clearButton.onclick = () => {
      this.selected.clear();
      this.filterButton.focus();
      onChange();
    };
    this.warning = this.root.createDiv({ cls: "study-cards-picker-warning", attr: { role: "status" } });
    this.list = this.root.createDiv({ cls: "study-cards-picker-list", attr: { tabindex: "0", role: "region",
      "aria-label": t("selectCheckCards") } });
  }

  get cardIds() { return [...this.selected.keys()]; }

  setVisible(visible: boolean) {
    this.root.hidden = this.count.hidden = this.clearButton.hidden = !visible;
  }

  private get filterButton() { return this.selectedOnly ? this.selectedButton : this.allButton; }

  private filter(selected: boolean) {
    if (this.selectedOnly === selected) return;
    this.selectedOnly = selected;
    this.list.scrollTop = 0;
    this.onChange();
  }

  update(cards: readonly CheckCard[], saving: boolean) {
    const available = new Set<string>();
    const notes = new Map<string, CheckCard[]>();
    for (const card of cards) {
      available.add(card.id);
      if (this.selected.has(card.id)) this.selected.set(card.id, card);
      const note = notes.get(card.path);
      if (note) note.push(card);
      else notes.set(card.path, [card]);
    }
    const unavailable = [...this.selected].filter(([id]) => !available.has(id));
    const query = this.search.value.trim().toLocaleLowerCase();
    this.root.disabled = saving;
    this.search.disabled = this.selectedOnly;
    this.allButton.setAttribute("aria-pressed", String(!this.selectedOnly));
    this.selectedButton.setAttribute("aria-pressed", String(this.selectedOnly));
    this.clearButton.disabled = saving || !this.selected.size;
    this.count.setText(t("selectedCheckCardCount", { count: this.selected.size }));
    this.warning.setText(unavailable.length ? t("selectedCardsChanged") : "");

    const focused = this.list.ownerDocument.activeElement;
    const focusedKey = this.list.contains(focused) ? (focused as HTMLElement).dataset.checkOption : undefined;
    const scrollTop = this.list.scrollTop;
    this.list.empty();
    let nextFocus: HTMLElement | undefined;
    const addOption = (parent: HTMLElement, key: string, label: string) => {
      const row = parent.createEl("label", { cls: "study-cards-picker-option" });
      const input = row.createEl("input", { type: "checkbox", attr: { "data-check-option": key } });
      const text = row.createSpan();
      text.createSpan({ text: label });
      if (key === focusedKey) nextFocus = input;
      return { row, input, text };
    };

    if (unavailable.length) {
      const group = this.list.createDiv({ cls: "study-cards-picker-note" });
      group.createEl("strong", { text: t("unavailableCheckSelection") });
      for (const [id, card] of unavailable) {
        const { input, text } = addOption(group, `card:${id}`, card.question);
        text.createSpan({ cls: "study-cards-picker-detail", text: card.path });
        input.checked = true;
        input.onchange = () => {
          this.selected.delete(id);
          this.onChange();
        };
      }
    }

    for (const [path, note] of notes) {
      const pathMatches = path.toLocaleLowerCase().includes(query);
      const visible = note.filter(({ id, question }) => this.selectedOnly ? this.selected.has(id)
        : pathMatches || question.toLocaleLowerCase().includes(query));
      if (!visible.length) continue;
      const group = this.list.createDiv({ cls: "study-cards-picker-note" });
      const { row, input, text } = addOption(group, `note:${path}`, path);
      row.addClass("study-cards-picker-note-option");
      const checked = note.filter(({ id }) => this.selected.has(id)).length;
      const count = t("questionSelectionCount", { selected: checked, total: note.length });
      row.createSpan({ cls: "study-cards-picker-detail study-cards-picker-note-count", text: t("pickerNoteCount", { selected: checked, total: note.length }),
        attr: { "aria-hidden": "true" } });
      input.setAttribute("aria-label", t("selectNoteCards", { path, count: note.length }) + ". " + count);
      input.checked = checked === note.length;
      input.indeterminate = checked > 0 && !input.checked;
      input.onchange = () => {
        for (const card of note) this.setSelected(card, input.checked);
        this.onChange();
      };
      for (const card of visible) {
        const { input } = addOption(group, `card:${card.id}`, card.question);
        input.checked = this.selected.has(card.id);
        input.onchange = () => {
          this.setSelected(card, input.checked);
          this.onChange();
        };
      }
    }
    if (!this.list.childElementCount) {
      this.list.createDiv({ cls: "study-cards-picker-detail",
        text: t(this.selectedOnly ? "noSelectedCheckCards" : "noMatchingCheckCards") });
    }
    this.list.scrollTop = scrollTop;
    if (focusedKey && !saving) (nextFocus ?? this.filterButton).focus({ preventScroll: true });
    return this.selected.size > 0 && unavailable.length === 0;
  }

  private setSelected(card: CheckCard, checked: boolean) {
    if (checked) this.selected.set(card.id, card);
    else this.selected.delete(card.id);
  }
}
