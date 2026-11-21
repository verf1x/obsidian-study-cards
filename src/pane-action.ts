import { setIcon } from "obsidian";

export function renderPaneAction(element: HTMLElement, icon: string, title: string, detail: string) {
  element.addClass("study-cards-action-row");
  const leading = element.createSpan({ cls: "study-cards-action-icon", attr: { "aria-hidden": "true" } });
  setIcon(leading, icon);
  const label = element.createSpan({ cls: "study-cards-action-label" });
  label.createEl("strong", { text: title });
  if (detail) label.createEl("small", { text: detail });
  const trailing = element.createSpan({ cls: "study-cards-action-chevron", attr: { "aria-hidden": "true" } });
  setIcon(trailing, "chevron-right");
}

export function renderPracticeRow(parent: HTMLElement, title: string, detail: string, action: string) {
  const row = parent.createDiv({ cls: "study-cards-practice-row" });
  const label = row.createDiv();
  label.createEl("strong", { text: title });
  label.createEl("small", { text: detail });
  return row.createEl("button", { text: action });
}
