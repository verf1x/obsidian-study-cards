import { Component, ItemView, MarkdownRenderer, Modal, Notice, setIcon, type App, type WorkspaceLeaf } from "obsidian";
import { FreeCheckView } from "./free-check-view";
import { reviewDue } from "./interval-queue";
import { IntervalView } from "./interval-view";
import { masteryLabels, t } from "./localization";
import type { Status } from "./markdown";
import { CheckPrompt } from "./free-check-modals";
import { renderPaneAction } from "./pane-action";
import { CreateCardModal, ManageSourceModal, message, SourceEnrollment, type WatchVault } from "./source-modals";
import { renderStudyStorage } from "./study-storage-view";
import type { Card, SourceRequest, StudyCards } from "./study-cards";
import type { Section } from "./study-state";

export const viewType = "study-cards";

export interface CatalogActions {
  createSection(): void;
  addSources(): void;
  createCard(): void;
}

const panes = ["practice", "cards", "history"] as const;
const paneIcons = { practice: "circle-play", cards: "list", history: "history" } as const;
type Pane = typeof panes[number];
const firstCheckKey = "study-cards-first-check-section";

export class StudyView extends ItemView {
  private unsubscribe?: () => void;
  private isOpen = false;
  private answers = new Component();
  private readonly freeCheck: FreeCheckView;
  private readonly interval: IntervalView;
  private pane: Pane = "practice";
  private readonly expanded = new Map<Pane, Set<string | null>>();
  private catalogQuery = "";
  private enrollment?: SourceEnrollment;
  private sectionPicker?: { element: HTMLElement; close: () => void };

  constructor(leaf: WorkspaceLeaf, protected readonly study: StudyCards, private readonly watch: WatchVault,
    protected readonly openNote: (path: string) => Promise<void>) {
    super(leaf);
    this.freeCheck = new FreeCheckView(this.app, study, this.contentEl, () => { if (this.isOpen) this.render(); },
      (root, card) => this.renderMarkdown(root, card), () => this.showPractice(), (sectionId) => {
        if (this.app.loadLocalStorage(firstCheckKey) === sectionId) this.app.saveLocalStorage(firstCheckKey, null);
      }, () => this.showPane("history"));
    this.interval = new IntervalView(study, this.contentEl, () => { if (this.isOpen) this.render(); },
      (root, card) => this.renderMarkdown(root, card));
    this.registerDomEvent(this.contentEl.doc, "pointerdown", (event) => {
      const picker = this.sectionPicker;
      if (picker && !picker.element.contains(event.target as Node)) picker.close();
    });
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
    this.enrollment?.close();
    this.enrollment = undefined;
    this.removeChild(this.answers);
  }

  connectNotes(requests: SourceRequest[] = []) {
    const section = this.study.sections.find(({ id }) => id === this.study.activeSection);
    this.showEnrollment(requests, section);
  }

  private showEnrollment(requests: SourceRequest[], section?: Section) {
    const { problem, saving } = this.study.persistence;
    if (this.enrollment?.confirming || problem || saving || !this.freeCheck.dismissSetup()) return;
    this.freeCheck.close();
    this.interval.close();
    this.enrollment?.close();
    const introductory = !this.study.sections.length && !this.study.freeChecks.results.length;
    const focus = this.contentEl.querySelector<HTMLElement>("[data-focus]:focus")?.dataset.focus;
    const root = this.contentEl;
    this.resetAnswers();
    root.empty();
    this.sectionPicker = undefined;
    delete root.dataset.studyPane;
    const container = root.createDiv({ cls: "study-cards-enrollment" });
    this.enrollment = new SourceEnrollment(this.app, container, this.study, this.watch, {
      section, initial: requests,
      onConnected: () => {
        this.enrollment?.close();
        this.enrollment = undefined;
        if (section) this.showPane("cards", "add-sources");
        else {
          this.catalogQuery = "";
          if (introductory) this.app.saveLocalStorage(firstCheckKey, this.study.activeSection);
          this.showPractice();
        }
      },
      onCancel: () => this.showPane(this.pane, focus),
    });
  }

  protected render() {
    this.interval.clearTimer();
    const root = this.contentEl;
    const { problem, saving } = this.study.persistence;
    if (this.enrollment || this.freeCheck.refreshSetup()) {
      this.renderRecovery(root);
      return;
    }
    const active = root.ownerDocument.activeElement;
    const previous = root.dataset.studyPane as Pane | undefined;
    if (previous) {
      this.expanded.set(previous, new Set([...root.querySelectorAll("details[open][data-card]")].map((item) => item.getAttribute("data-card"))));
    }
    const focus = root.contains(active) ? active?.getAttribute("data-focus") : undefined;
    const opened = this.expanded.get(this.pane) ?? new Set<string | null>();
    this.resetAnswers();
    root.empty();
    this.sectionPicker = undefined;
    root.addClass("study-cards-view");
    delete root.dataset.studyPane;
    this.renderRecovery(root);
    if (this.freeCheck.settingUp) this.renderNavigation(root, this.pane);
    if (this.renderAlternateScreen(root)) return;

    root.dataset.studyPane = this.pane;
    const section = this.study.sections.find(({ id }) => id === this.study.activeSection);
    this.renderNavigation(root, this.pane, section);
    if (this.pane === "history") {
      this.freeCheck.renderHistory(root, section);
    } else if (!section) {
      const firstUse = root.createDiv({ cls: "study-cards-first-use" });
      firstUse.createEl("h2", { text: t("startWithYourNotes") });
      firstUse.createEl("p", { text: t("connectFirstNotes") });
      const connect = firstUse.createEl("button", { text: t("connectNotes"), cls: "mod-cta", attr: { "data-focus": "connect" } });
      connect.disabled = Boolean(problem) || saving;
      connect.onclick = () => this.connectNotes();
    } else {
      const toolbar = root.createDiv({ cls: "study-cards-section-controls" });
      const title = toolbar.createDiv({ cls: "study-cards-section-title" });
      title.createEl("h2", { text: section.name });
      const actions = {
        createSection: () => this.showEnrollment([]),
        addSources: () => this.connectNotes(),
        createCard: () => new CreateCardModal(this.app, this.study, section.id, this.openNote).open(),
      };
      if (this.pane === "practice") this.renderSectionActions(root, section.id, section.name, opened, toolbar, title);
      else {
        this.renderCatalogActions(toolbar, actions);
        this.renderSources(root, section, opened);
        this.renderCatalog(root, section.id, opened);
      }
    }
    if (focus) this.focusPaneControl(focus);
  }

  private renderRecovery(root: HTMLElement) {
    root.querySelector(":scope > .study-cards-recovery")?.remove();
    const { problem, saving } = this.study.persistence;
    if (!problem && !saving) return;
    const recovery = root.ownerDocument.createElement("div");
    recovery.className = "study-cards-recovery";
    root.prepend(recovery);
    renderStudyStorage(this.app, recovery, this.study);
  }

  private renderNavigation(root: HTMLElement, active: Pane, section?: Section) {
    const nav = root.createEl("nav", { cls: "study-cards-pane-nav", attr: { "aria-label": t("paneNavigation") } });
    for (const pane of panes) {
      const button = nav.createEl("button", { attr: { "data-focus": pane } });
      setIcon(button.createSpan({ cls: "study-cards-nav-icon", attr: { "aria-hidden": "true" } }), paneIcons[pane]);
      button.createSpan({ text: t(pane) });
      if (active === pane && !this.freeCheck.settingUp) button.setAttribute("aria-current", "page");
      button.onclick = () => this.showPane(pane);
    }
    if (!this.freeCheck.settingUp) this.renderSectionPicker(nav, section);
  }

  private renderSectionPicker(nav: HTMLElement, section?: Section) {
    const picker = nav.createDiv({ cls: "study-cards-section-picker" });
    const label = section ? t("currentStudySection", { name: section.name }) : t("chooseStudySection");
    const trigger = picker.createEl("button", { cls: "study-cards-section-trigger",
      attr: { "aria-label": label, "aria-haspopup": "menu",
        "aria-expanded": "false", "data-focus": "section" } });
    trigger.createSpan({ text: section?.name ?? label });
    setIcon(trigger.createSpan({ cls: "study-cards-nav-icon", attr: { "aria-hidden": "true" } }), "chevron-down");
    const menu = picker.createDiv({ cls: "study-cards-section-menu-panel", attr: { role: "menu", "aria-label": t("studySection") } });
    menu.hidden = true;
    const close = (focus: boolean) => {
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      this.sectionPicker = undefined;
      if (focus) trigger.focus();
    };
    const add = (label: string, action: () => void, role = "menuitem") => {
      const item = menu.createEl("button", { text: label, attr: { role, tabindex: "-1" } });
      item.onclick = () => { close(true); action(); };
      return item;
    };
    for (const { id, name } of this.study.sections) {
      const item = add(name, () => {
        this.catalogQuery = "";
        this.perform(this.study.openSection(id).then(() => this.focusPaneControl("section")));
      }, "menuitemradio");
      item.setAttribute("aria-checked", String(id === section?.id));
    }
    if (section) menu.createEl("hr", { attr: { role: "separator" } });
    const { problem, saving } = this.study.persistence;
    const blocked = Boolean(problem) || saving;
    add(t("newSection"), () => this.showEnrollment([])).disabled = blocked;
    if (section) {
      const remove = add(t("deleteSectionMenu"), () => this.confirmSectionDeletion(section));
      remove.disabled = blocked;
      remove.addClass("study-cards-danger");
    } else trigger.disabled = blocked;
    const items = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const open = (item?: HTMLButtonElement) => {
      menu.hidden = false;
      this.sectionPicker = { element: picker, close: () => close(false) };
      trigger.setAttribute("aria-expanded", "true");
      (item ?? items.find((entry) => entry.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
    };
    trigger.onclick = () => { if (menu.hidden) open(); else close(true); };
    picker.addEventListener("focusout", (event) => {
      if (!picker.contains(event.relatedTarget as Node | null)) close(false);
    });
    picker.onkeydown = (event) => {
      if (!menu.hidden && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      const direction = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (!direction && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      const current = items.findIndex((item) => item === event.target);
      const next = event.key === "Home" ? 0 : event.key === "End" || (current < 0 && direction < 0) ? items.length - 1
        : (current + direction + items.length) % items.length;
      open(items[next]);
    };
  }

  private confirmSectionDeletion(section: Section) {
    const { revision, session } = this.study.freeChecks;
    const unfinished = session?.sectionId === section.id ? session : null;
    const choices = [];
    if (unfinished) choices.push({
      label: t("continueFreeCheck"), action: () => this.freeCheck.resume(unfinished.id), primary: true,
    });
    choices.push({ label: t("deleteSection"), danger: true, action: () => this.perform(
      this.study.removeSection({ id: globalThis.crypto.randomUUID(), revision }, section.id).then(() => {
        this.catalogQuery = "";
        if (!this.study.activeSection) this.showPractice();
        else this.showPane(this.pane, "section");
      }),
    ) });
    new CheckPrompt(this.app, t("deleteNamedSection", { name: section.name }), t("deleteSectionRetention"), choices,
      unfinished ? t("deleteSectionDiscardsCheck") : undefined).open();
  }
  protected showPane(pane: Pane, focus: string = pane) {
    if (!this.freeCheck.dismissSetup()) return;
    if (this.enrollment?.confirming) return;
    this.enrollment?.close();
    this.enrollment = undefined;
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
    const target = this.contentEl.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]:not(:disabled)`);
    target?.focus({ preventScroll: true });
    return target;
  }

  private renderSources(root: HTMLElement, section: Section, opened: Set<string | null>) {
    const details = root.createEl("details", { cls: "study-cards-connected-sources", attr: { "data-card": "sources" } });
    details.open = opened.has("sources");
    details.createEl("summary", { text: t("sourceCount", { count: section.sources.length }) });
    const missing = new Set(this.study.missingSources(section.id).map(({ id }) => id));
    const { problem, saving } = this.study.persistence;
    for (const source of section.sources) {
      const path = source.path || t("vaultRoot");
      const item = details.createDiv({ cls: "study-cards-item" });
      item.createDiv({ text: source.recursive ? t("sourceWithSubfolders", { path }) : path });
      const row = item.createDiv({ cls: "study-cards-controls study-cards-source-actions" });
      if (missing.has(source.id)) {
        row.createSpan({ text: t("sourceUnavailable") });
        const reconnect = row.createEl("button", { text: t("reconnect") });
        reconnect.disabled = Boolean(problem) || saving;
        reconnect.onclick = () => new ManageSourceModal(this.app, this.study, this.watch, section, source, true).open();
      } else if (source.kind === "file") {
        row.createEl("button", { text: t("openNote"), attr: { "aria-label": t("openNoteNamed", { path }) } })
          .onclick = () => this.perform(this.openNote(source.path));
      } else {
        const configure = row.createEl("button", { text: t("configureSource") });
        configure.disabled = Boolean(problem) || saving;
        configure.onclick = () => new ManageSourceModal(this.app, this.study, this.watch, section, source).open();
      }
      const disconnect = row.createEl("button", { text: t("disconnect"), attr: { "aria-label": t("disconnectNamedSource", { path }) } });
      disconnect.disabled = Boolean(problem) || saving;
      disconnect.onclick = () => this.perform(this.study.removeSource(section.id, source.id));
    }
  }
  protected renderAlternateScreen(root: HTMLElement): boolean {
    return this.interval.renderScreen(root) || this.freeCheck.renderScreen(root);
  }

  protected renderSectionActions(root: HTMLElement, sectionId: string, name: string, _opened: Set<string | null>,
    toolbar: HTMLElement, title: HTMLElement) {
    title.createEl("p", { text: t("sectionCardCount", { count: this.study.cards(sectionId).length }) });
    const practice = root.createDiv({ cls: "study-cards-practice" });
    this.freeCheck.renderPractice(practice, toolbar, sectionId, name, this.app.loadLocalStorage(firstCheckKey) === sectionId,
      () => this.showPane("cards", "add-sources"), () => this.interval.renderCatalog(practice, sectionId));
  }

  protected renderCatalogActions(toolbar: HTMLElement, actions: CatalogActions) {
    const group = toolbar.createDiv({ cls: "study-cards-controls" });
    const { problem, saving } = this.study.persistence;
    const connect = group.createEl("button", { text: t("connectNotes"), cls: "mod-cta", attr: { "data-focus": "add-sources" } });
    connect.disabled = Boolean(problem) || saving;
    connect.onclick = actions.addSources;
    const create = group.createEl("button", { attr: { "aria-label": t("createCard"), title: t("createCard"), "data-focus": "create-card" } });
    setIcon(create, "plus");
    create.disabled = connect.disabled;
    create.onclick = actions.createCard;
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
        this.connectNotes([{ kind: "file", path }]);
    }
  }

  protected renderCatalog(root: HTMLElement, sectionId: string, opened: Set<string | null>) {
    const cards = this.study.cards(sectionId, "source");
    root.createEl("h2", { text: t("cards"), attr: { tabindex: "-1", "data-focus": "cards-heading" } });
    root.createEl("p", { cls: "study-cards-catalog-count", text: t("sectionCardCount", { count: cards.length }) });
    this.renderErrors(root, sectionId);
    const search = root.createEl("input", { cls: "study-cards-catalog-search", type: "search",
      placeholder: t("catalogSearch"), attr: { "aria-label": t("catalogSearch"), "data-focus": "catalog-search" } });
    search.value = this.catalogQuery;
    const empty = root.createEl("p", { text: t("noCatalogMatches"), attr: { role: "status" } });
    const list = root.createDiv({ cls: "study-cards-catalog-list" });
    const rows = cards.map((card) => {
      const key = this.cardKey(card);
      const mounted = this.renderCard(list, card, key, opened.has(key), (summary) => {
        renderPaneAction(summary, "file-text", card.question, card.path);
      });
      return { mounted, content: `${card.question}\n${card.path}`.toLocaleLowerCase() };
    });
    const filter = () => {
      this.catalogQuery = search.value;
      const query = search.value.trim().toLocaleLowerCase();
      let visible = 0;
      for (const { mounted, content } of rows) {
        mounted.hidden = !content.includes(query);
        if (!mounted.hidden) visible++;
      }
      empty.hidden = visible > 0;
    };
    search.oninput = filter;
    filter();
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
    return details;
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
