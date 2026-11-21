import { Component, ItemView, MarkdownRenderer, Modal, Notice, type App, type WorkspaceLeaf } from "obsidian";
import { statuses, type Status } from "./markdown";
import { CreateCardModal, message, SelectSourcesModal, type WatchVault } from "./source-modals";
import type { Card, StudyCards } from "./study-cards";

export const viewType = "study-cards";

export interface CatalogActions {
  createSection(): void;
  addSources(): void;
  createCard(): void;
}

export class StudyView extends ItemView {
  private unsubscribe?: () => void;
  private answers = new Component();

  constructor(leaf: WorkspaceLeaf, protected readonly study: StudyCards, private readonly watch: WatchVault,
    protected readonly openNote: (path: string) => Promise<void>) {
    super(leaf);
  }

  getViewType() { return viewType; }
  getDisplayText() { return "Study Cards"; }
  getIcon() { return "book-open"; }

  async onOpen() {
    this.unsubscribe = this.study.subscribe(() => this.render());
    this.render();
  }

  async onClose() {
    this.unsubscribe?.();
    this.removeChild(this.answers);
  }

  protected render() {
    const root = this.contentEl;
    const opened = new Set([...root.querySelectorAll("details[open]")].map((item) => item.getAttribute("data-card")));
    this.resetAnswers();
    root.empty();
    root.addClass("study-cards-view");
    if (this.renderAlternateScreen(root)) return;

    const toolbar = root.createDiv({ cls: "study-cards-controls" });
    const createSection = () => new SectionModal(this.app, this.study).open();
    const sectionId = this.study.activeSection;
    const section = this.study.sections.find(({ id }) => id === sectionId);
    if (this.study.sections.length) {
      const label = toolbar.createEl("label", { text: "Раздел " });
      const select = label.createEl("select", { attr: { "aria-label": "Учебный раздел", "data-focus": "section" } });
      for (const { id, name } of this.study.sections) select.createEl("option", { value: id, text: name });
      select.value = section?.id ?? "";
      select.onchange = () => this.perform(this.study.openSection(select.value));
    }
    if (!section) {
      toolbar.createEl("button", { text: "Новый раздел" }).onclick = createSection;
      root.createEl("p", { text: "Создайте учебный раздел, чтобы добавить заметки или папки." });
      return;
    }
    this.renderSectionActions(root, section.id, section.name, opened);

    const sourceRow = root.createDiv();
    const sources = sourceRow.createEl("details", { attr: { "data-card": "sources" } });
    this.renderCatalogActions(toolbar, sourceRow, {
      createSection,
      addSources: () => new SelectSourcesModal(this.app, this.study, this.watch, section.id, []).open(),
      createCard: () => new CreateCardModal(this.app, this.study, section.id, this.openNote).open(),
    });
    sources.open = opened.has("sources");
    sources.createEl("summary", { text: "Источники · " + section.sources.length });
    for (const source of section.sources) {
      const row = sources.createDiv({ cls: "study-cards-controls study-cards-item" });
      row.createSpan({ text: (source.path || "Корень хранилища") + (source.recursive ? " · с подпапками" : "") });
      if (source.kind === "folder") {
        row.createEl("button", { text: "Настроить" }).onclick = () =>
          new SelectSourcesModal(this.app, this.study, this.watch, section.id, [source], true).open();
      }
      row.createEl("button", { text: "Отключить" }).onclick = () => this.perform(this.study.removeSource(section.id, source.id));
    }
    this.renderCatalog(root, section.id, opened);
  }

  protected renderAlternateScreen(_root: HTMLElement): boolean { return false; }

  protected renderSectionActions(_root: HTMLElement, _sectionId: string, _name: string, _opened: Set<string | null>) {}

  protected renderCatalogActions(toolbar: HTMLElement, _sourceRow: HTMLElement, actions: CatalogActions) {
    toolbar.createEl("button", { text: "Новый раздел" }).onclick = actions.createSection;
    toolbar.createEl("button", { text: "Добавить источники" }).onclick = actions.addSources;
    toolbar.createEl("button", { text: "Создать карточку", cls: "mod-cta" }).onclick = actions.createCard;
  }

  protected resetAnswers() {
    this.removeChild(this.answers);
    this.answers = this.addChild(new Component());
  }

  protected renderErrors(root: HTMLElement, sectionId: string) {
    for (const { path, message } of this.study.errors(sectionId)) {
      const error = root.createDiv({ cls: "study-cards-item" });
      error.createEl("p", { text: path + " · " + message });
      error.createEl("button", { text: "Открыть заметку" }).onclick = () => this.perform(this.openNote(path));
      error.createEl("button", { text: "Предпросмотр подключения" }).onclick = () =>
        new SelectSourcesModal(this.app, this.study, this.watch, sectionId, [{ kind: "file", path }]).open();
    }
  }

  protected renderCatalog(root: HTMLElement, sectionId: string, opened: Set<string | null>) {
    const cards = this.study.cards(sectionId);
    root.createEl("h3", { text: "Карточки · " + cards.length });
    this.renderErrors(root, sectionId);
    for (const card of cards) {
      const key = this.cardKey(card);
      this.renderCard(root, card, key, opened.has(key));
    }
  }

  protected cardKey(card: Card) { return card.path + ":" + (card.id ?? "") + ":" + card.index; }

  protected renderCard(root: HTMLElement, card: Card, key: string, open: boolean, summaryContent?: (summary: HTMLElement) => void) {
    const details = root.createEl("details", { cls: "study-cards-item", attr: { "data-card": key } });
    details.open = open;
    const summary = details.createEl("summary");
    if (summaryContent) summaryContent(summary);
    else summary.textContent = card.question;
    this.renderCardSummary(summary, card);
    const body = details.createDiv({ cls: "study-cards-card-body" });
    let rendered = false;
    const renderAnswer = () => {
      if (rendered || !details.open) return;
      rendered = true;
      this.renderCardBody(body, card);
    };
    details.ontoggle = renderAnswer;
    renderAnswer();
  }

  protected renderCardSummary(_summary: HTMLElement, _card: Card) {}

  protected renderCardBody(root: HTMLElement, card: Card, includeExtraActions = true) {
    const actions = root.createDiv({ cls: "study-cards-controls study-cards-card-actions" });
    actions.createEl("button", { text: card.path, attr: { "aria-label": "Открыть заметку " + card.path } }).onclick =
      () => this.perform(this.openNote(card.path));
    const select = actions.createEl("label", { text: "Статус освоения " }).createEl("select");
    if (card.status === "invalid") {
      select.createEl("option", { value: "invalid", text: "Некорректный статус" }).disabled = true;
    }
    for (const [value, text] of Object.entries(statuses)) select.createEl("option", { value, text });
    select.value = card.status;
    select.onchange = () => {
      const status = select.value as Status;
      select.value = card.status;
      this.perform(this.study.setStatus(card, status));
    };

    if (card.identity === "duplicate" && card.id) {
      actions.createEl("button", { text: "Разрешить конфликт UUID" }).onclick =
        () => new DuplicateModal(this.app, this.study, card.id!).open();
    } else if (card.identity === "missing" || card.identity === "invalid") {
      actions.createSpan({ text: card.identity === "missing" ? "UUID отсутствует" : "Некорректный UUID" });
      actions.createEl("button", { text: "Создать новый ID" }).onclick = () => this.perform(this.study.repairId(card));
    }
    if (includeExtraActions) this.renderCardActions(actions, card);

    void this.renderMarkdown(root.createDiv(), card);
    if (card.progress) {
      const results = root.createEl("details");
      results.createEl("summary", { text: "Результаты и расписание" });
      if (card.progress.history !== undefined) results.createEl("pre", { text: JSON.stringify(card.progress.history, null, 2) });
      if (card.progress.schedule !== undefined) results.createEl("pre", { text: JSON.stringify(card.progress.schedule, null, 2) });
    }
  }

  protected renderCardActions(_root: HTMLElement, _card: Card) {}

  protected async renderMarkdown(root: HTMLElement, card: Card) {
    root.addClass("markdown-rendered", "study-cards-markdown");
    try {
      await MarkdownRenderer.render(this.app, card.answer, root, card.path, this.answers);
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
        const label = table.caption?.textContent?.trim() || (tables.length > 1 ? "Таблица " + (index + 1) : "Таблица");
        scroll.setAttrs({ tabindex: "0", role: "region", "aria-label": label });
      }
    } catch (error) {
      new Notice(message(error));
    }
  }

  protected perform(promise: Promise<unknown>) {
    void promise.catch((error) => new Notice(message(error)));
  }
}

class SectionModal extends Modal {
  constructor(app: App, private readonly study: StudyCards) { super(app); }

  onOpen() {
    this.setTitle("Новый учебный раздел");
    this.contentEl.addClass("study-cards-form-modal");
    const form = this.contentEl.createEl("form", { cls: "study-cards-form" });
    const name = form.createEl("label", { text: "Название " }).createEl("input", { type: "text" });
    name.required = true;
    name.focus();
    const error = form.createEl("p", { attr: { role: "status" } });
    const submit = form.createEl("button", { type: "submit", text: "Создать раздел", cls: "mod-cta" });
    form.onsubmit = (event) => {
      event.preventDefault();
      submit.disabled = true;
      void this.study.addSection(name.value).then(() => this.close()).catch((reason) => {
        error.textContent = message(reason);
        submit.disabled = false;
      });
    };
  }
}

class DuplicateModal extends Modal {
  constructor(app: App, private readonly study: StudyCards, private readonly id: string) { super(app); }

  onOpen() {
    this.setTitle("Конфликт UUID");
    this.contentEl.addClass("study-cards-form-modal");
    const cards = this.study.duplicates(this.id);
    if (cards.length < 2) {
      this.contentEl.createEl("p", { text: "Конфликт уже решён." });
      return;
    }
    const selectCard = (label: string) => {
      const select = this.contentEl.createEl("label", { cls: "study-cards-form", text: label }).createEl("select");
      select.createEl("option", { value: "", text: "Выберите карточку" }).disabled = true;
      cards.forEach((card, index) => select.createEl("option", {
        text: card.path + " · " + card.question + " · строка " + card.line,
        value: String(index),
      }));
      select.value = "";
      return select;
    };
    const keep = selectCard("Сохранить историю у");
    const change = selectCard("Изменить карточку");
    const actions = this.contentEl.createDiv({ cls: "study-cards-controls" });
    const renew = actions.createEl("button", { text: "Выдать новый UUID", cls: "mod-cta" });
    const trash = actions.createEl("button", { text: "Переместить заметку в корзину", cls: "mod-warning" });
    const update = () => {
      renew.disabled = keep.value === "" || change.value === "" || keep.value === change.value;
      const card = cards[Number(change.value)];
      trash.disabled = renew.disabled || !card || !this.study.canTrash(card);
    };
    const resolve = (action: "new-id" | "trash") => {
      const winner = cards[Number(keep.value)];
      const other = cards[Number(change.value)];
      if (!winner || !other) return;
      const apply = () => {
        renew.disabled = trash.disabled = true;
        void this.study.resolveDuplicate(winner, other, action).then(() => this.close()).catch((error) => {
          new Notice(message(error));
          update();
        });
      };
      if (action === "new-id") apply();
      else new TrashModal(this.app, other.path, apply).open();
    };
    keep.onchange = change.onchange = update;
    renew.onclick = () => resolve("new-id");
    trash.onclick = () => resolve("trash");
    update();
  }
}

class TrashModal extends Modal {
  constructor(app: App, private readonly path: string, private readonly confirm: () => void) { super(app); }

  onOpen() {
    this.setTitle("Переместить заметку в корзину?");
    this.contentEl.createEl("p", { text: this.path });
    this.contentEl.createEl("button", { text: "Переместить в корзину хранилища", cls: "mod-warning" }).onclick = () => {
      this.close();
      this.confirm();
    };
  }
}
