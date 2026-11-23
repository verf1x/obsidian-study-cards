import { MarkdownRenderer, type App, type Component } from "obsidian";
import { t } from "./localization";

export async function renderCardMarkdown(app: App, root: HTMLElement, answer: string, path: string, owner: Component) {
  root.addClass("markdown-rendered", "study-cards-markdown");
  await MarkdownRenderer.render(app, answer, root, path, owner);
  if (!root.isConnected) return;
  const tables = [...root.querySelectorAll("table")];
  for (const [index, table] of tables.entries()) {
    const parent = table.parentElement;
    const scroll = parent?.matches(".table-wrapper, .study-cards-table-scroll")
      ? parent : root.ownerDocument.createElement("div");
    if (scroll !== parent) {
      table.before(scroll);
      scroll.append(table);
    }
    scroll.addClass("study-cards-table-scroll");
    const label = table.caption?.textContent?.trim() || (tables.length > 1 ? t("numberedTable", { number: index + 1 }) : t("table"));
    scroll.setAttrs({ tabindex: "0", role: "region", "aria-label": label });
  }
}
