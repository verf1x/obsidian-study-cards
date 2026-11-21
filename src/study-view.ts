import { Component, ItemView, MarkdownRenderer, Modal, Notice, type App, type WorkspaceLeaf } from "obsidian";
import { FreeCheckView } from "./free-check-view";
import { reviewDue } from "./interval-queue";
import { IntervalView } from "./interval-view";
import { masteryLabels, t } from "./localization";
import type { Status } from "./markdown";
import { configureNoteQuestions } from "./note-questions-modal";
import { CreateCardModal, message, SelectSourcesModal, type WatchVault } from "./source-modals";
import { renderStudyStorage } from "./study-storage-view";
import type { Card, StudyCards } from "./study-cards";

export const viewType = "study-cards";

export interface CatalogActions {
  createSection(): void;
  addSources(): void;
  createCard(): void;
}

export class StudyView extends ItemView {
  private unsubscribe?: () => void;
  private isOpen = false;
  private answers = new Component();
  private readonly freeCheck: FreeCheckView;
  private readonly interval: IntervalView;

  constructor(leaf: WorkspaceLeaf, protected readonly study: StudyCards, private readonly watch: WatchVault,
    protected readonly openNote: (path: string) => Promise<void>) {
    super(leaf);
    this.freeCheck = new FreeCheckView(this.app, study, this.contentEl, () => { if (this.isOpen) this.render(); },
      (root, card) => this.renderMarkdown(root, card));
    this.interval = new IntervalView(study, this.contentEl, () => { if (this.isOpen) this.render(); },
      (root, card) => this.renderMarkdown(root, card));
  }

  getViewType() { return viewType; }
  getDisplayText() { return "Study Cards"; }
  getIcon() { return "book-open"; }

  async onOpen() {
    this.isOpen = true;
    this.unsubscribe = this.study.subscribe(() => this.render());
    this.render();
  }

  async onClose() {
    this.isOpen = false;
    this.unsubscribe?.();
    this.interval.close();
    this.removeChild(this.answers);
  }

  protected render() {
    this.interval.clearTimer();
    const root = this.contentEl;
    const opened = new Set([...root.querySelectorAll("details[open]")].map((item) => item.getAttribute("data-card")));
    this.resetAnswers();
    root.empty();
    root.addClass("study-cards-view");
    renderStudyStorage(this.app, root, this.study, opened);
    if (this.renderAlternateScreen(root)) return;

    const toolbar = root.createDiv({ cls: "study-cards-controls" });
    const createSection = () => new SectionModal(this.app, this.study).open();
    const sectionId = this.study.activeSection;
    const section = this.study.sections.find(({ id }) => id === sectionId);
    if (this.study.sections.length) {
      const label = toolbar.createEl("label", { text: t("section") + " " });
      const select = label.createEl("select", { attr: { "aria-label": t("studySection"), "data-focus": "section" } });
      for (const { id, name } of this.study.sections) select.createEl("option", { value: id, text: name });
      select.value = section?.id ?? "";
      select.onchange = () => this.perform(this.study.openSection(select.value));
    }
    if (!section) {
      toolbar.createEl("button", { text: t("newSection") }).onclick = createSection;
      root.createEl("p", { text: t("createSectionFirst") });
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
    sources.createEl("summary", { text: t("sourceCount", { count: section.sources.length }) });
    const missing = new Set(this.study.missingSources(section.id).map(({ id }) => id));
    if (missing.size) sources.open = true;
    for (const source of section.sources) {
      const row = sources.createDiv({ cls: "study-cards-controls study-cards-item" });
      const path = source.path || t("vaultRoot");
      row.createSpan({ text: source.recursive ? t("sourceWithSubfolders", { path }) : path });
      if (missing.has(source.id)) {
        row.createSpan({ text: t("sourceUnavailable") });
        row.createEl("button", { text: t("reconnect") }).onclick = () =>
          new SelectSourcesModal(this.app, this.study, this.watch, section.id, [], false, source).open();
      } else {
        const folder = source.kind === "folder";
        row.createEl("button", {
          text: t(folder ? "configureQuestions" : "configure"),
          attr: { "aria-label": t("configureQuestionsFrom", { path }) },
        }).onclick = () => configureNoteQuestions(this.app, this.study, section.id, source);
        if (folder) row.createEl("button", { text: t("configureSource") }).onclick = () =>
          new SelectSourcesModal(this.app, this.study, this.watch, section.id, [source], true).open();
      }
      row.createEl("button", { text: t("disconnect") }).onclick = () => this.perform(this.study.removeSource(section.id, source.id));
    }
    this.renderCatalog(root, section.id, opened);
  }

  protected renderAlternateScreen(root: HTMLElement): boolean {
    return this.interval.renderScreen(root) || this.freeCheck.renderScreen(root);
  }

  protected renderSectionActions(root: HTMLElement, sectionId: string, name: string, opened: Set<string | null>) {
    this.interval.renderCatalog(root, sectionId, opened);
    this.freeCheck.renderCatalog(root, sectionId, name, opened);
  }

  protected renderCatalogActions(toolbar: HTMLElement, _sourceRow: HTMLElement, actions: CatalogActions) {
    toolbar.createEl("button", { text: t("newSection") }).onclick = actions.createSection;
    toolbar.createEl("button", { text: t("addSources") }).onclick = actions.addSources;
    toolbar.createEl("button", { text: t("createCard"), cls: "mod-cta" }).onclick = actions.createCard;
  }

  protected resetAnswers() {
    this.removeChild(this.answers);
    this.answers = this.addChild(new Component());
  }

  protected renderErrors(root: HTMLElement, sectionId: string) {
    for (const { path, message } of this.study.errors(sectionId)) {
      const error = root.createDiv({ cls: "study-cards-item" });
      error.createEl("p", { text: t("noteError", { path, message }) });
      error.createEl("button", { text: t("openNote") }).onclick = () => this.perform(this.openNote(path));
      error.createEl("button", { text: t("enrollmentPreview") }).onclick = () =>
        new SelectSourcesModal(this.app, this.study, this.watch, sectionId, [{ kind: "file", path }]).open();
    }
  }

  protected renderCatalog(root: HTMLElement, sectionId: string, opened: Set<string | null>) {
    const cards = this.study.cards(sectionId, "source");
    root.createEl("h3", { text: t("cardCount", { count: cards.length }) });
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
    actions.createEl("button", { text: card.path, attr: { "aria-label": t("openNoteNamed", { path: card.path }) } }).onclick =
      () => this.perform(this.openNote(card.path));
    const select = actions.createEl("label", { text: t("masteryStatus") + " " }).createEl("select");
    if (card.status === "invalid") {
      select.createEl("option", { value: "invalid", text: t("invalidStatus") }).disabled = true;
    }
    for (const [value, label] of Object.entries(masteryLabels)) select.createEl("option", { value, text: t(label) });
    select.value = card.status;
    select.onchange = () => {
      const status = select.value as Status;
      select.value = card.status;
      this.perform(this.study.setStatus(card, status));
    };

    if (card.identity === "duplicate" && card.id) {
      actions.createEl("button", { text: t("resolveUuidConflict") }).onclick =
        () => new DuplicateModal(this.app, this.study, card.id!).open();
    } else if (card.identity === "missing" || card.identity === "invalid") {
      actions.createSpan({ text: card.identity === "missing" ? t("missingUuid") : t("invalidUuid") });
      actions.createEl("button", { text: t("createNewId") }).onclick = () => this.perform(this.study.repairId(card));
    }
    if (includeExtraActions) this.renderCardActions(actions, card);

    void this.renderMarkdown(root.createDiv(), card);
    const reviews = card.progress?.reviews;
    const legacySchedule = reviewDue(card) ? undefined : card.progress?.schedule;
    if (reviews?.length || card.progress?.history !== undefined || legacySchedule !== undefined) {
      const results = root.createEl("details");
      results.createEl("summary", { text: t("resultsAndSchedule") });
      if (reviews?.length) this.interval.renderCardReviews(results, reviews);
      if (card.progress?.history !== undefined) results.createEl("pre", { text: JSON.stringify(card.progress.history, null, 2) });
      if (legacySchedule !== undefined) results.createEl("pre", { text: JSON.stringify(legacySchedule, null, 2) });
    }
  }

  protected renderCardActions(root: HTMLElement, card: Card) {
    this.interval.renderCardAction(root, card);
    const section = this.study.sections.find(({ id }) => id === this.study.activeSection);
    if (section) this.freeCheck.renderCardAction(root, card, section.id, section.name);
  }

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
        const label = table.caption?.textContent?.trim() || (tables.length > 1 ? t("numberedTable", { number: index + 1 }) : t("table"));
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
    this.setTitle(t("newStudySection"));
    this.contentEl.addClass("study-cards-form-modal");
    const form = this.contentEl.createEl("form", { cls: "study-cards-form" });
    const name = form.createEl("label", { text: t("name") + " " }).createEl("input", { type: "text" });
    name.required = true;
    name.focus();
    const error = form.createEl("p", { attr: { role: "status" } });
    const submit = form.createEl("button", { type: "submit", text: t("createSection"), cls: "mod-cta" });
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
    this.setTitle(t("uuidConflict"));
    this.contentEl.addClass("study-cards-form-modal");
    const cards = this.study.duplicates(this.id);
    if (cards.length < 2) {
      this.contentEl.createEl("p", { text: t("conflictResolved") });
      return;
    }
    const selectCard = (label: string) => {
      const select = this.contentEl.createEl("label", { cls: "study-cards-form", text: label }).createEl("select");
      select.createEl("option", { value: "", text: t("chooseCard") }).disabled = true;
      cards.forEach((card, index) => select.createEl("option", {
        text: t("duplicateCardLocation", { path: card.path, question: card.question, line: card.line }),
        value: String(index),
      }));
      select.value = "";
      return select;
    };
    const keep = selectCard(t("keepHistoryFor"));
    const change = selectCard(t("changeCard"));
    const actions = this.contentEl.createDiv({ cls: "study-cards-controls" });
    const renew = actions.createEl("button", { text: t("assignNewUuid"), cls: "mod-cta" });
    const trash = actions.createEl("button", { text: t("trashNote"), cls: "mod-warning" });
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
    this.setTitle(t("confirmTrashNote"));
    this.contentEl.createEl("p", { text: this.path });
    this.contentEl.createEl("button", { text: t("moveToVaultTrash"), cls: "mod-warning" }).onclick = () => {
      this.close();
      this.confirm();
    };
  }
}
