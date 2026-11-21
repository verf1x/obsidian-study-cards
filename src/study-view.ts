import { Component, ItemView, MarkdownRenderer, Modal, Notice, setIcon, type App, type WorkspaceLeaf } from "obsidian";
import { FreeCheckView } from "./free-check-view";
import { reviewDue } from "./interval-queue";
import { IntervalView } from "./interval-view";
import { masteryLabels, t } from "./localization";
import type { Status } from "./markdown";
import { configureNoteQuestions } from "./note-questions-modal";
import { CreateCardModal, message, SelectSourcesModal, type WatchVault } from "./source-modals";
import { renderStudyStorage } from "./study-storage-view";
import type { Card, SourceRequest, StudyCards } from "./study-cards";
import type { Section } from "./study-state";

export const viewType = "study-cards";

export interface CatalogActions {
  createSection(): void;
  addSources(): void;
  createCard(): void;
}

const panes = ["practice", "cards", "notes"] as const;
type Pane = typeof panes[number];
const firstCheckSections = new WeakMap<StudyCards, string>();

export class StudyView extends ItemView {
  private unsubscribe?: () => void;
  private isOpen = false;
  private answers = new Component();
  private readonly freeCheck: FreeCheckView;
  private readonly interval: IntervalView;
  private pane: Pane = "practice";
  private readonly expanded = new Map<Pane, Set<string | null>>();

  constructor(leaf: WorkspaceLeaf, protected readonly study: StudyCards, private readonly watch: WatchVault,
    protected readonly openNote: (path: string) => Promise<void>) {
    super(leaf);
    this.freeCheck = new FreeCheckView(this.app, study, this.contentEl, () => { if (this.isOpen) this.render(); },
      (root, card) => this.renderMarkdown(root, card), () => this.showPractice(), (sectionId) => {
        if (firstCheckSections.get(this.study) === sectionId) firstCheckSections.delete(this.study);
      });
    this.interval = new IntervalView(study, this.contentEl, () => { if (this.isOpen) this.render(); },
      (root, card) => this.renderMarkdown(root, card));
  }

  getViewType() { return viewType; }
  getDisplayText() { return "Study Cards"; }
  getIcon() { return "book-open"; }

  async onOpen() {
    this.isOpen = true;
    this.pane = "practice";
    this.unsubscribe = this.study.subscribe(() => this.render());
    this.render();
  }

  async onClose() {
    this.isOpen = false;
    this.unsubscribe?.();
    this.interval.close();
    this.freeCheck.close();
    this.removeChild(this.answers);
  }

  connectNotes(requests: SourceRequest[] = []) {
    const target = this.study.activeSection ?? {
      onConnected: () => {
        const section = this.study.activeSection;
        if (section) firstCheckSections.set(this.study, section);
        if (this.isOpen) this.showPractice();
      },
    };
    new SelectSourcesModal(this.app, this.study, this.watch, target, requests).open();
  }

  protected render() {
    this.interval.clearTimer();
    if (this.freeCheck.refreshSetup()) return;
    const root = this.contentEl;
    const previous = root.dataset.studyPane as Pane | undefined;
    if (previous) {
      this.expanded.set(previous, new Set([...root.querySelectorAll("details[open]")].map((item) => item.getAttribute("data-card"))));
    }
    const active = root.ownerDocument.activeElement;
    const focus = root.contains(active) ? active?.getAttribute("data-focus") : undefined;
    const opened = this.expanded.get(this.pane) ?? new Set<string | null>();
    this.resetAnswers();
    root.empty();
    root.addClass("study-cards-view");
    delete root.dataset.studyPane;
    const { problem, saving } = this.study.persistence;
    if (problem || saving) renderStudyStorage(this.app, root, this.study, opened);
    if (this.renderAlternateScreen(root)) return;

    root.dataset.studyPane = this.pane;
    const createSection = () => new SectionModal(this.app, this.study).open();
    const sectionId = this.study.activeSection;
    const section = this.study.sections.find(({ id }) => id === sectionId);
    if (!section) {
      const firstUse = root.createDiv({ cls: "study-cards-first-use" });
      firstUse.createEl("p", { text: t("connectFirstNotes") });
      const actions = firstUse.createDiv({ cls: "study-cards-controls" });
      const connect = actions.createEl("button", { text: t("connectNotes"), cls: "mod-cta", attr: { "data-focus": "connect" } });
      connect.disabled = Boolean(problem) || saving;
      connect.onclick = () => this.connectNotes();
      const empty = actions.createEl("button", { text: t("newSection") });
      empty.disabled = connect.disabled;
      empty.onclick = createSection;
    } else {
      this.renderNavigation(root);
      const toolbar = root.createDiv({ cls: "study-cards-section-controls" });
      const label = toolbar.createEl("label", { text: t("studySection") });
      const select = label.createEl("select", { attr: { "data-focus": "section" } });
      for (const { id, name } of this.study.sections) select.createEl("option", { value: id, text: name });
      select.value = section.id;
      select.onchange = () => {
        this.perform(this.study.openSection(select.value).then(() => this.focusPaneControl("section")));
      };
      const actions = {
        createSection,
        addSources: () => this.connectNotes(),
        createCard: () => new CreateCardModal(this.app, this.study, section.id, this.openNote).open(),
      };
      if (this.pane === "practice") this.renderSectionActions(root, section.id, section.name, opened);
      if (this.pane === "cards") {
        this.renderCatalogActions(toolbar, actions);
        this.renderCatalog(root, section.id, opened);
      }
      if (this.pane === "notes") this.renderSources(root, section, actions);
    }
    if (!problem && !saving) {
      renderStudyStorage(this.app, root.createDiv({ cls: "study-cards-data-tools" }), this.study, opened);
    }
    if (focus) this.focusPaneControl(focus);
  }

  private renderNavigation(root: HTMLElement) {
    const nav = root.createEl("nav", { cls: "study-cards-pane-nav", attr: { "aria-label": t("paneNavigation") } });
    for (const pane of panes) {
      const button = nav.createEl("button", { text: t(pane), attr: { "data-focus": pane } });
      if (this.pane === pane) button.setAttribute("aria-current", "page");
      button.onclick = () => this.showPane(pane);
    }
  }

  protected showPane(pane: Pane, focus: string = pane) {
    this.pane = pane;
    this.render();
    if (!this.focusPaneControl(focus) && focus !== pane) this.focusPaneControl(pane);
  }

  private showPractice() {
    this.pane = "practice";
    this.render();
    const next = this.contentEl.querySelector<HTMLElement>(
      '[data-focus="check-continue"], [data-focus="check-start"]:not(:disabled), [data-focus="connect"]:not(:disabled)',
    ) ?? this.contentEl.querySelector<HTMLElement>('[data-focus="practice"]');
    next?.focus({ preventScroll: true });
  }

  private focusPaneControl(key: string) {
    const target = this.contentEl.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`);
    target?.focus({ preventScroll: true });
    return target;
  }

  private renderSources(root: HTMLElement, section: Section, actions: CatalogActions) {
    const header = root.createDiv({ cls: "study-cards-source-header" });
    header.createEl("h2", { text: t("sourceCount", { count: section.sources.length }) });
    const buttons = header.createDiv({ cls: "study-cards-controls" });
    const add = buttons.createEl("button", { text: t("connectNotes"), cls: "mod-cta", attr: { "data-focus": "add-sources" } });
    add.onclick = actions.addSources;
    buttons.createEl("button", { text: t("newSection") }).onclick = actions.createSection;
    this.renderErrors(root, section.id);
    const sources = root.createDiv();
    const missing = new Set(this.study.missingSources(section.id).map(({ id }) => id));
    for (const source of section.sources) {
      const path = source.path || t("vaultRoot");
      const item = sources.createDiv({ cls: "study-cards-item" });
      item.createDiv({ text: source.recursive ? t("sourceWithSubfolders", { path }) : path });
      const row = item.createDiv({ cls: "study-cards-controls study-cards-source-actions" });
      if (missing.has(source.id)) {
        row.createSpan({ text: t("sourceUnavailable") });
        row.createEl("button", { text: t("reconnect") }).onclick = () =>
          new SelectSourcesModal(this.app, this.study, this.watch, section.id, [], false, source).open();
      } else {
        const folder = source.kind === "folder";
        if (!folder) row.createEl("button", { text: t("openNote"), attr: { "aria-label": t("openNoteNamed", { path }) } })
          .onclick = () => this.perform(this.openNote(source.path));
        row.createEl("button", {
          text: t(folder ? "configureQuestions" : "configure"),
          attr: { "aria-label": t("configureQuestionsFrom", { path }) },
        }).onclick = () => configureNoteQuestions(this.app, this.study, section.id, source);
        if (folder) row.createEl("button", { text: t("configureSource") }).onclick = () =>
          new SelectSourcesModal(this.app, this.study, this.watch, section.id, [source], true).open();
      }
      row.createEl("button", { text: t("disconnect") }).onclick = () => this.perform(this.study.removeSource(section.id, source.id));
    }
  }

  protected renderAlternateScreen(root: HTMLElement): boolean {
    return this.interval.renderScreen(root) || this.freeCheck.renderScreen(root);
  }

  protected renderSectionActions(root: HTMLElement, sectionId: string, name: string, opened: Set<string | null>) {
    const practice = root.createDiv({ cls: "study-cards-practice" });
    this.freeCheck.renderPractice(practice, sectionId, name, firstCheckSections.get(this.study) === sectionId,
      () => this.showPane("notes", "add-sources"));
    this.freeCheck.renderHistory(practice, sectionId, opened);
    const study = practice.createDiv({ cls: "study-cards-practice-row" });
    study.createEl("button", { text: t("study") }).onclick = () => this.showPane("cards", "cards-heading");
    study.createEl("p", { text: t("studyHint") });
    this.interval.renderCatalog(practice, sectionId, opened);
  }

  protected renderCatalogActions(toolbar: HTMLElement, actions: CatalogActions) {
    const group = toolbar.createDiv({ cls: "study-cards-controls" });
    const create = group.createEl("button", { attr: { "aria-label": t("createCard"), title: t("createCard"), "data-focus": "create-card" } });
    setIcon(create, "plus");
    create.onclick = actions.createCard;
    group.createEl("button", { text: t("newSection") }).onclick = actions.createSection;
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
    root.createEl("h2", { text: t("cardCount", { count: cards.length }), attr: { tabindex: "-1", "data-focus": "cards-heading" } });
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
