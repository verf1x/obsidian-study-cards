import type { CheckCard } from "./free-check";
import { t } from "./localization";

type CardLabel = Pick<CheckCard, "question" | "path">;

export class CardPicker {
  readonly root: HTMLFieldSetElement;
  private readonly selected = new Map<string, CardLabel>();
  private readonly search: HTMLInputElement;
  private readonly selectedOnly: HTMLInputElement;
  private readonly clear: HTMLButtonElement;
  private readonly count: HTMLElement;
  private readonly warning: HTMLElement;
  private readonly list: HTMLElement;

  constructor(root: HTMLElement, start: CheckCard | undefined, private readonly onChange: () => void) {
    if (start) this.selected.set(start.id, start);
    this.root = root.createEl("fieldset", { cls: "study-cards-picker", attr: { "aria-label": t("selectCheckCards") } });
    this.search = this.root.createEl("input", {
      type: "search", placeholder: t("searchCheckCards"), attr: { "aria-label": t("searchCheckCards") },
    });
    this.search.oninput = onChange;
    this.search.onkeydown = (event) => { if (event.key === "Enter") event.preventDefault(); };
    const tools = this.root.createDiv({ cls: "study-cards-controls study-cards-picker-tools" });
    const filter = tools.createEl("label", { cls: "study-cards-picker-filter" });
    this.selectedOnly = filter.createEl("input", { type: "checkbox" });
    filter.createSpan({ text: t("selectedCheckCardsOnly") });
    this.selectedOnly.onchange = onChange;
    this.clear = tools.createEl("button", { text: t("clearCheckSelection"), attr: { type: "button" } });
    this.clear.onclick = () => {
      this.selected.clear();
      this.selectedOnly.focus();
      onChange();
    };
    const status = this.root.createDiv();
    this.count = status.createDiv({ attr: { role: "status" } });
    this.warning = status.createDiv({ cls: "study-cards-picker-warning", attr: { role: "status" } });
    this.list = this.root.createDiv({ cls: "study-cards-picker-list", attr: { tabindex: "0", role: "region",
      "aria-label": t("selectCheckCards") } });
  }

  get cardIds() { return [...this.selected.keys()]; }

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
    const review = this.selectedOnly.checked;
    const query = this.search.value.trim().toLocaleLowerCase();
    this.root.disabled = saving;
    this.search.disabled = review;
    this.clear.disabled = !this.selected.size;
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
      const visible = note.filter(({ id, question }) => review ? this.selected.has(id)
        : pathMatches || question.toLocaleLowerCase().includes(query));
      if (!visible.length) continue;
      const group = this.list.createDiv({ cls: "study-cards-picker-note" });
      const { row, input, text } = addOption(group, `note:${path}`, path);
      row.addClass("study-cards-picker-note-option");
      text.createSpan({ cls: "study-cards-picker-detail", text: t("eligibleNoteCardCount", { count: note.length }) });
      input.setAttribute("aria-label", t("selectNoteCards", { path, count: note.length }));
      const checked = note.filter(({ id }) => this.selected.has(id)).length;
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
      this.list.createDiv({ cls: "study-cards-picker-detail", text: t(review ? "noSelectedCheckCards" : "noMatchingCheckCards") });
    }
    this.list.scrollTop = scrollTop;
    if (focusedKey && !saving) (nextFocus ?? this.selectedOnly).focus({ preventScroll: true });
    return this.selected.size > 0 && unavailable.length === 0;
  }

  private setSelected(card: CheckCard, checked: boolean) {
    if (checked) this.selected.set(card.id, card);
    else this.selected.delete(card.id);
  }
}
