import { Menu, Notice, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { statuses } from "../markdown";
import type { WatchVault } from "../source-modals";
import type { Card, StudyCards } from "../study-cards";
import { StudyView, type CatalogActions } from "../study-view";
import { Check, isCheckCard, PrototypeChecks, type CheckCard, type Grade } from "./check";
import { CheckModal, SetupModal } from "./modals";

const layouts = { list: "Список", table: "Таблица", split: "С ответом" };
type Layout = keyof typeof layouts;
const layoutOrder = Object.keys(layouts) as Layout[];

export class PrototypeView extends StudyView {
  private layout: Layout = "list";
  private selected?: string;
  private search = "";
  private catalogSection?: string;
  private shownCheck?: Check;
  private report?: Check;
  private lastAnswer?: { check: Check; id: string; markdown: string };
  private updated = false;
  private scrollTop = 0;
  private unsubscribeChecks?: () => void;

  constructor(leaf: WorkspaceLeaf, study: StudyCards, watch: WatchVault, openNote: (path: string) => Promise<void>,
    private readonly checks: PrototypeChecks) {
    super(leaf, study, watch, openNote);
  }

  async onOpen() {
    this.unsubscribeChecks = this.checks.subscribe(() => {
      if (this.shownCheck !== this.checks.active) this.shownCheck = undefined;
      this.render();
    });
    await super.onOpen();
  }

  async onClose() {
    this.unsubscribeChecks?.();
    await super.onClose();
  }

  getState() { return { ...super.getState(), layout: this.layout }; }

  async setState(state: unknown, result: ViewStateResult) {
    await super.setState(state, result);
    if (state && typeof state === "object" && "layout" in state
      && typeof state.layout === "string" && layoutOrder.includes(state.layout as Layout)) {
      this.layout = state.layout as Layout;
      this.render();
    }
  }

  protected render() {
    const previous = this.contentEl.querySelector<HTMLElement>(".study-cards-check");
    const focused = this.contentEl.ownerDocument.activeElement;
    const focus = this.contentEl.contains(focused) ? focused?.getAttribute("data-focus") : undefined;
    const search = focus === "search" ? focused as HTMLInputElement : undefined;
    const start = search?.selectionStart;
    const end = search?.selectionEnd;
    const sameQuestion = previous?.dataset.position === String(this.shownCheck?.position);
    this.scrollTop = sameQuestion ? previous?.querySelector(".study-cards-check-body")?.scrollTop ?? 0 : 0;
    super.render();
    if (focus && (sameQuestion || (!previous && !this.shownCheck && !this.report))) {
      const target = this.focus(focus);
      if (start != null && end != null) (target as HTMLInputElement | null)?.setSelectionRange(start, end);
    }
  }

  protected renderSectionActions(root: HTMLElement, sectionId: string, name: string, opened: Set<string | null>) {
    const cards = this.study.cards(sectionId);
    const available = cards.filter(isCheckCard).length;
    const header = root.createDiv({ cls: "study-cards-section-header" });
    root.prepend(header);
    const title = header.createDiv();
    title.createEl("h1", { text: "Карточки", attr: { tabindex: "-1", "data-focus": "catalog" } });
    const count = cards.length;
    title.createEl("p", {
      cls: "study-cards-muted",
      text: "Всего: " + count + (available < count ? " · Для проверки: " + available : ""),
    });
    const actions = header.createDiv({ cls: "study-cards-controls" });
    if (this.checks.active) {
      const active = this.checks.active;
      actions.createEl("button", { cls: "mod-cta", text: "Продолжить проверку" }).onclick = () => this.showCheck(active);
    }
    const start = actions.createEl("button", {
      text: "Свободная проверка", cls: this.checks.active ? undefined : "mod-cta",
    });
    start.disabled = available === 0;
    start.onclick = () => this.setup(sectionId, name);

    const history = this.checks.history.filter((check) => check.sectionId === sectionId);
    if (history.length) {
      const details = root.createEl("details", { cls: "study-cards-history", attr: { "data-card": "history" } });
      details.open = opened.has("history");
      details.createEl("summary", { text: "История проверок · " + history.length });
      history.forEach((check, index) => {
        const label = check.retry ? "Повтор ошибок" : "Свободная проверка";
        details.createEl("button", {
          text: (history.length - index) + " · " + label + " · верно " + check.correct + " из " + check.graded,
        }).onclick = () => this.showReport(check);
      });
    }
  }

  protected renderCatalogActions(toolbar: HTMLElement, sourceRow: HTMLElement, actions: CatalogActions) {
    toolbar.addClass("study-cards-section-controls");
    const more = toolbar.createEl("button", {
      cls: "study-cards-section-menu",
      attr: { "aria-label": "Действия раздела", "aria-haspopup": "menu", "aria-expanded": "false" },
    });
    setIcon(more, "ellipsis");
    more.onclick = () => {
      const menu = new Menu().setUseNativeMenu(false).setNoIcon();
      menu.addItem((item) => item.setTitle("Новый раздел").onClick(actions.createSection));
      menu.addItem((item) => item.setTitle("Создать карточку").onClick(actions.createCard));
      menu.onHide(() => more.setAttribute("aria-expanded", "false"));
      more.setAttribute("aria-expanded", "true");
      const { left, bottom } = more.getBoundingClientRect();
      menu.showAtPosition({ x: left, y: bottom }, more.ownerDocument);
    };
    sourceRow.addClass("study-cards-source-row");
    sourceRow.createEl("button", { text: "Добавить источники" }).onclick = actions.addSources;
  }

  protected renderCatalog(root: HTMLElement, sectionId: string, opened: Set<string | null>) {
    if (this.catalogSection !== sectionId) {
      this.catalogSection = sectionId;
      this.search = "";
      this.selected = undefined;
    }
    const cards = this.study.cards(sectionId, "source");
    this.renderErrors(root, sectionId);
    if (!cards.length) {
      root.createEl("p", { text: "Добавьте источник или создайте карточку.", cls: "study-cards-empty" });
      return;
    }
    const bar = root.createDiv({ cls: "study-cards-catalog-tools" });
    const search = bar.createEl("input", {
      type: "search", placeholder: "Найти карточку", value: this.search,
      attr: { "aria-label": "Найти карточку", "data-focus": "search" },
    });
    const label = bar.createEl("label");
    label.createSpan({ text: "Вид каталога" });
    const layout = label.createEl("select", { attr: { "aria-label": "Вид каталога", "data-focus": "layout" } });
    for (const [value, text] of Object.entries(layouts)) layout.createEl("option", { value, text });
    layout.value = this.layout;
    const status = root.createDiv({ cls: "study-cards-search-status study-cards-muted", attr: { role: "status" } });
    const results = root.createDiv();
    const positions = new Map(cards.map((card, index) => [card, index + 1]));
    const renderResults = (expanded: Set<string | null>) => {
      const query = this.search.trim().toLocaleLowerCase();
      const visible = query ? cards.filter(({ question }) => question.toLocaleLowerCase().includes(query)) : cards;
      status.textContent = !query ? "" : visible.length
        ? "Найдено: " + visible.length + " из " + cards.length : "Карточки не найдены.";
      results.empty();
      if (!visible.length) return;
      if (this.layout === "table") this.renderTable(results, visible, expanded, positions);
      else if (this.layout === "split") this.renderSplit(results, visible, expanded);
      else {
        const list = results.createDiv({ cls: "study-cards-catalog-list" });
        visible.forEach((card) => this.renderCard(list, card, this.cardKey(card), expanded.has(this.cardKey(card))));
      }
    };
    const refreshResults = () => {
      const expanded = new Set([...results.querySelectorAll("details[open]")].map((row) => row.getAttribute("data-card")));
      this.resetAnswers();
      renderResults(expanded);
    };
    search.oninput = () => {
      this.search = search.value;
      refreshResults();
    };
    layout.onchange = () => {
      this.layout = layout.value as Layout;
      refreshResults();
      void this.app.workspace.requestSaveLayout();
    };
    renderResults(opened);
  }

  private renderTable(root: HTMLElement, cards: Card[], opened: Set<string | null>, positions: Map<Card, number>) {
    const table = root.createDiv({ cls: "study-cards-catalog-table" });
    const header = table.createDiv({ cls: "study-cards-table-row study-cards-table-header", attr: { "aria-hidden": "true" } });
    ["№", "Вопрос", "Заметка", "Статус освоения"].forEach((label) => header.createSpan({ text: label }));
    cards.forEach((card) => {
      const key = this.cardKey(card);
      this.renderCard(table, card, key, opened.has(key), (summary) => {
        summary.addClass("study-cards-table-row");
        summary.createSpan({ text: String(positions.get(card)), cls: "study-cards-muted" });
        summary.createSpan({ text: card.question });
        summary.createSpan({ text: card.path, cls: "study-cards-muted study-cards-table-path" });
      });
    });
  }

  private renderSplit(root: HTMLElement, cards: Card[], opened: Set<string | null>) {
    const selected = cards.find((card) => this.cardKey(card) === this.selected) ?? cards[0]!;
    const split = root.createDiv({ cls: "study-cards-catalog-split" });
    const list = split.createDiv({ cls: "study-cards-split-list" });
    const detail = split.createDiv({ cls: "study-cards-catalog-detail" });
    const show = (card: Card, restoreOpen = false) => {
      detail.empty();
      detail.createEl("h3", { text: card.question });
      if (isCheckCard(card)) this.renderCardActions(detail.createDiv({ cls: "study-cards-controls" }), card);
      const key = "split:" + this.cardKey(card);
      const answer = detail.createEl("details", { attr: { "data-card": key } });
      const summary = answer.createEl("summary");
      const body = answer.createDiv();
      const update = () => {
        summary.textContent = answer.open ? "Скрыть ответ" : "Показать ответ";
        if (answer.open && !body.hasChildNodes()) this.renderCardBody(body, card, false);
      };
      answer.open = restoreOpen && opened.has(key);
      answer.ontoggle = update;
      update();
    };
    cards.forEach((card) => {
      const button = list.createEl("button", {
        text: card.question, attr: { "aria-pressed": String(card === selected) },
      });
      button.onclick = () => {
        if (button.getAttribute("aria-pressed") === "true") return;
        this.selected = this.cardKey(card);
        list.querySelector('button[aria-pressed="true"]')?.setAttribute("aria-pressed", "false");
        button.setAttribute("aria-pressed", "true");
        this.resetAnswers();
        show(card);
        detail.scrollTop = 0;
      };
    });
    show(selected, true);
  }

  protected renderCardSummary(root: HTMLElement, card: Card) {
    root.createSpan({
      cls: "study-cards-status",
      text: card.status === "invalid" ? "Некорректный статус" : statuses[card.status],
      attr: { "data-status": card.status },
    });
  }

  protected renderCardActions(root: HTMLElement, card: Card) {
    if (isCheckCard(card)) {
      const sectionId = this.study.activeSection!;
      const section = this.study.sections.find(({ id }) => id === sectionId)!;
      root.createEl("button", { text: "Начать с этой карточки", cls: "study-cards-start-here" }).onclick =
        () => this.setup(sectionId, section.name, card.id);
    }
  }

  private setup(sectionId: string, name: string, start?: string) {
    const restoreFocus = this.returnFocus();
    const open = (previous?: Check) => {
      new SetupModal(this.app, name, () => this.study.cards(sectionId, "source").filter(isCheckCard),
        (listener) => this.study.subscribe(listener), start, (selected) => {
          if (this.checks.active !== previous) {
            new Notice("Свободная проверка изменилась. Откройте настройку снова.");
            return;
          }
          this.showCheck(new Check(sectionId, name, selected));
        }, restoreFocus).open();
    };
    this.replaceCheck(open);
  }

  private replaceCheck(launch: (previous?: Check) => void) {
    const active = this.checks.active;
    if (!active) {
      launch();
      return;
    }
    new CheckModal(this.app, "Есть незавершённая проверка", active.sectionName + " · оценено "
      + active.graded + " из " + active.questions.length + ". При запуске новой проверки текущие оценки будут сброшены.", [
      { label: "Настроить новую", action: () => launch(active) },
      { label: "Продолжить текущую", action: () => {
        if (this.checks.active) this.showCheck(this.checks.active);
      }, primary: true },
    ], this.returnFocus()).open();
  }

  private showCheck(check: Check) {
    this.shownCheck = check;
    this.report = undefined;
    this.checks.start(check);
    this.focus("question");
  }

  private showReport(report: Check) {
    this.report = report;
    this.shownCheck = undefined;
    this.render();
    this.focus("report");
  }

  private catalog() {
    this.report = this.shownCheck = undefined;
    this.render();
    this.focus("catalog");
  }

  private focus(name: string) {
    const target = this.contentEl.querySelector<HTMLElement>('[data-focus="' + name + '"]');
    target?.focus({ preventScroll: true });
    return target;
  }

  private returnFocus() {
    const opener = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
    return () => {
      if (opener && this.contentEl.contains(opener)) opener.focus();
      else this.focus(this.report ? "report" : "catalog");
    };
  }

  protected renderAlternateScreen(root: HTMLElement) {
    root.toggleClass("study-cards-in-check", Boolean(this.shownCheck));
    root.addClass("study-cards-prototype");
    if (this.shownCheck) this.renderCheck(root, this.shownCheck);
    else if (this.report) this.renderReport(root, this.report);
    return Boolean(this.shownCheck || this.report);
  }

  private renderCheck(root: HTMLElement, check: Check) {
    const source = this.study.cards(check.sectionId).find(({ id }) => id === check.current.id);
    const card = source && isCheckCard(source) ? source : undefined;
    const revealed = check.revealed.has(check.current.id);
    if (this.lastAnswer?.check !== check || this.lastAnswer.id !== check.current.id) this.updated = false;
    else if (card && this.lastAnswer.markdown !== card.answer) this.updated = true;
    this.lastAnswer = card ? { check, id: card.id, markdown: card.answer } : undefined;

    const panel = root.createDiv({ cls: "study-cards-check", attr: { "data-position": String(check.position) } });
    const header = panel.createDiv({ cls: "study-cards-check-header" });
    const context = header.createDiv();
    context.createEl("strong", { text: check.retry ? "Повтор ошибок" : "Свободная проверка" });
    context.createEl("p", { text: check.sectionName, cls: "study-cards-muted" });
    header.createEl("button", { text: "К каталогу" }).onclick = () => this.catalog();

    const progress = panel.createDiv({ cls: "study-cards-check-progress" });
    progress.createSpan({ text: "Вопрос " + (check.position + 1) + " из " + check.questions.length });
    progress.createSpan({ text: "Оценено " + check.graded + " из " + check.questions.length });
    progress.createEl("progress", { attr: {
      value: String(check.graded), max: String(check.questions.length), "aria-label": "Оценённые вопросы",
    } });

    const body = panel.createDiv({ cls: "study-cards-check-body" });
    body.createEl("h1", { text: source?.question ?? check.current.question, attr: { tabindex: "-1", "data-focus": "question" } });
    if (!card) {
      const text = source?.status === "invalid" ? "Некорректный статус освоения. Исправьте его в каталоге или перейдите дальше."
        : "Карточка недоступна. Можно перейти дальше.";
      body.createEl("p", { text, cls: "study-cards-empty" });
    } else if (revealed) {
      body.createEl("button", { text: card.path, cls: "study-cards-note-link" }).onclick = () => this.perform(this.openNote(card.path));
      const answer = body.createDiv({ cls: "study-cards-answer" });
      answer.createEl("h2", { text: "Ответ", attr: { tabindex: "-1", "data-focus": "answer" } });
      if (this.updated) answer.createEl("p", { text: "Ответ обновлён в заметке", cls: "study-cards-muted" });
      const scrollTop = this.scrollTop;
      void this.renderMarkdown(answer.createDiv(), card).then(() => {
        if (scrollTop && body.isConnected) body.scrollTop = scrollTop;
      });
    }

    const footer = panel.createDiv({ cls: "study-cards-check-footer" });
    const gradeBar = footer.createDiv({ cls: "study-cards-grade-bar" });
    const nav = footer.createDiv({ cls: "study-cards-check-nav" });
    const back = nav.createEl("button", { text: "Назад", attr: { "data-focus": "back" } });
    back.disabled = check.position === 0;
    back.onclick = () => this.move(check, -1);
    const last = check.position === check.questions.length - 1;
    const canAdvance = !card || Boolean(check.current.grade) || check.position < check.reached;
    if (!last) {
      nav.createEl("button", { text: "Завершить", attr: { "data-focus": "finish" } }).onclick =
        () => this.confirmFinish(check, "finish");
    }
    const next = nav.createEl("button", {
      text: last ? "Завершить" : "Далее", cls: canAdvance ? "mod-cta" : undefined, attr: { "data-focus": "next" },
    });
    next.disabled = !last && !canAdvance;
    next.onclick = () => last ? this.confirmFinish(check, "next") : this.move(check, 1);

    if (card && !revealed) {
      const reveal = gradeBar.createEl("button", {
        text: "Показать ответ", cls: "mod-cta", attr: { "data-focus": "reveal", "aria-keyshortcuts": "Space" },
      });
      reveal.onclick = () => {
        this.checks.update(check, () => { check.revealed.add(card.id); });
        this.focus("answer");
      };
      footer.createEl("p", { text: "Пробел — показать ответ", cls: "study-cards-shortcuts" });
      this.bindKeys(panel, { " ": reveal, ArrowLeft: back, ArrowRight: last ? undefined : next });
    } else if (card) {
      const correct = this.gradeButton(gradeBar, check, card, "correct", "Верно", "1");
      const wrong = this.gradeButton(gradeBar, check, card, "wrong", "Ошибка", "2");
      footer.createEl("p", { text: "1 — верно · 2 — ошибка · ← → — навигация", cls: "study-cards-shortcuts" });
      this.bindKeys(panel, { "1": correct, "2": wrong, ArrowLeft: back, ArrowRight: last && !canAdvance ? undefined : next });
    } else {
      gradeBar.hidden = true;
      if (check.current.grade) footer.createEl("p", {
        text: "Оценка сохранена: " + (check.current.grade === "correct" ? "верно" : "ошибка"), cls: "study-cards-muted",
      });
      this.bindKeys(panel, { ArrowLeft: back, ArrowRight: next });
    }
  }

  private move(check: Check, direction: -1 | 1) {
    this.checks.update(check, () => check.move(direction));
    this.focus("question");
  }

  private gradeButton(root: HTMLElement, check: Check, card: CheckCard, grade: Grade, text: string, key: string) {
    const button = root.createEl("button", { text, attr: {
      "aria-pressed": String(check.current.grade === grade), "aria-keyshortcuts": key, "data-focus": grade, "data-grade": grade,
    } });
    button.onclick = () => {
      this.checks.update(check, () => check.rate(card, grade));
      this.focus(grade);
    };
    return button;
  }

  private bindKeys(root: HTMLElement, keys: Record<string, HTMLButtonElement | undefined>) {
    root.onkeydown = (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
      const target = event.target as HTMLElement;
      if (target.closest("a, input, select, textarea, summary, pre, [contenteditable], .study-cards-table-scroll, .math-block")
        || (event.key === " " && target.closest("button"))) return;
      const button = keys[event.key];
      if (!button || button.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      button.click();
    };
  }

  private confirmFinish(check: Check, focus: string) {
    const ungraded = check.ungraded;
    const summary = "Оценено " + check.graded + " из " + check.questions.length
      + ". Без оценки: " + ungraded + ".";
    new CheckModal(this.app, "Подтвердить итог?", summary, [{
      label: "Подтвердить итог", primary: true, action: () => {
        if (this.checks.active !== check) return;
        if (check.ungraded !== ungraded) {
          this.confirmFinish(check, focus);
          return;
        }
        if (this.checks.finish(check)) this.showReport(check);
      },
    }], () => this.focus(focus)).open();
  }

  private renderReport(root: HTMLElement, check: Check) {
    const report = root.createDiv({ cls: "study-cards-report" });
    report.createEl("p", { text: check.sectionName, cls: "study-cards-muted" });
    report.createEl("h1", { text: check.retry ? "Итог повтора ошибок" : "Итог свободной проверки",
      attr: { tabindex: "-1", "data-focus": "report" },
    });
    const percent = check.graded ? Math.round(check.correct * 100 / check.graded) + "% верных" : "Нет оценённых ответов";
    const score = report.createDiv({ cls: "study-cards-score" });
    score.createEl("strong", { text: percent });
    score.createEl("p", { text: "Оценено " + check.graded + " из " + check.questions.length });
    const counts = report.createEl("dl", { cls: "study-cards-counts" });
    const mistakes = check.mistakes;
    for (const [label, value] of [["Верно", check.correct], ["Ошибка", mistakes.length], ["Без оценки", check.ungraded]]) {
      const item = counts.createDiv();
      item.createEl("dt", { text: String(label) });
      item.createEl("dd", { text: String(value) });
    }
    if (mistakes.length) {
      report.createEl("h2", { text: "Вопросы с ошибками" });
      const current = new Map(this.study.cards(check.sectionId).filter(isCheckCard).map((card) => [card.id, card]));
      const list = report.createEl("ol", { cls: "study-cards-mistakes" });
      for (const item of mistakes) {
        const card = current.get(item.id);
        list.createEl("li", { text: card?.question ?? item.question + " · недоступен" });
      }
      const retry = report.createEl("button", { text: "Повтор ошибок", cls: "mod-cta" });
      retry.disabled = !mistakes.some(({ id }) => current.has(id));
      if (retry.disabled) report.createEl("p", { text: "Все вопросы с ошибками недоступны.", cls: "study-cards-muted" });
      retry.onclick = () => this.replaceCheck((previous) => {
        if (this.checks.active !== previous) return;
        const available = this.study.cards(check.sectionId).filter(isCheckCard);
        if (!mistakes.some((item) => available.some(({ id }) => id === item.id))) {
          new Notice("Все вопросы с ошибками недоступны");
          return;
        }
        this.showCheck(new Check(check.sectionId, check.sectionName, mistakes, true));
      });
    }
    report.createEl("button", { text: "К каталогу" }).onclick = () => this.catalog();
  }
}
