import { Notice, type WorkspaceLeaf } from "obsidian";
import { statuses } from "../markdown";
import type { WatchVault } from "../source-modals";
import type { Card, StudyCards } from "../study-cards";
import { StudyView } from "../study-view";
import { catalogCards, Check, isCheckCard, PrototypeChecks, type CheckCard, type Grade } from "./check";
import { CheckModal, SetupModal } from "./modals";

const layouts = { list: "Список", table: "Таблица", split: "С ответом" };
type Layout = keyof typeof layouts;

export class PrototypeView extends StudyView {
  private layout: Layout = "list";
  private selected?: string;
  private shownCheck?: Check;
  private report?: Check;
  private lastAnswer?: { check: Check; id: string; markdown: string };
  private updated = false;
  private scrollTop = 0;

  constructor(leaf: WorkspaceLeaf, study: StudyCards, watch: WatchVault, openNote: (path: string) => Promise<void>,
    private readonly checks: PrototypeChecks) {
    super(leaf, study, watch, openNote);
  }

  protected render() {
    const previous = this.contentEl.querySelector<HTMLElement>(".study-cards-check");
    const focused = this.contentEl.ownerDocument.activeElement;
    const focus = previous?.contains(focused) ? focused?.getAttribute("data-focus") : undefined;
    const sameQuestion = previous?.dataset.position === String(this.shownCheck?.position);
    this.scrollTop = sameQuestion ? previous?.querySelector(".study-cards-check-body")?.scrollTop ?? 0 : 0;
    super.render();
    if (sameQuestion && focus) this.focus(focus);
  }

  protected renderSectionActions(root: HTMLElement, sectionId: string, name: string) {
    const cards = this.study.cards(sectionId);
    const header = root.createDiv({ cls: "study-cards-section-header" });
    const title = header.createDiv();
    title.createEl("h1", { text: name, attr: { tabindex: "-1", "data-focus": "catalog" } });
    const count = cards.length;
    title.createEl("p", {
      cls: "study-cards-muted",
      text: "Карточек: " + count + " · доступно для проверки: " + cards.filter(isCheckCard).length,
    });
    const actions = header.createDiv({ cls: "study-cards-controls" });
    if (this.checks.active) {
      const active = this.checks.active;
      actions.createEl("button", { cls: "mod-cta", text: "Продолжить проверку" }).onclick = () => this.showCheck(active);
    }
    const start = actions.createEl("button", {
      text: "Свободная проверка", cls: this.checks.active ? undefined : "mod-cta",
    });
    start.disabled = !cards.some(isCheckCard);
    start.onclick = () => this.setup(sectionId, name);

    const history = this.checks.history.filter((check) => check.sectionId === sectionId);
    if (history.length) {
      const details = root.createEl("details", { cls: "study-cards-history" });
      details.createEl("summary", { text: "История проверок · " + history.length });
      history.forEach((check, index) => {
        const label = check.retry ? "Повтор ошибок" : "Свободная проверка";
        details.createEl("button", {
          text: (history.length - index) + " · " + label + " · верно " + check.correct + " из " + check.graded,
        }).onclick = () => this.showReport(check);
      });
    }
  }

  protected renderCatalog(root: HTMLElement, sectionId: string, opened: Set<string | null>) {
    const cards = catalogCards(this.study, sectionId);
    const header = root.createDiv({ cls: "study-cards-catalog-header" });
    header.createEl("h2", { text: "Карточки" });
    const layout = header.createEl("label", { text: "Вид каталога" }).createEl("select", {
      attr: { "aria-label": "Вид каталога" },
    });
    for (const [value, text] of Object.entries(layouts)) layout.createEl("option", { value, text });
    layout.value = this.layout;
    layout.onchange = () => {
      this.layout = layout.value as Layout;
      this.render();
      root.querySelector<HTMLSelectElement>(".study-cards-catalog-header select")?.focus();
    };
    this.renderErrors(root, sectionId);
    if (!cards.length) {
      root.createEl("p", { text: "Добавьте источник или создайте карточку.", cls: "study-cards-empty" });
      return;
    }
    if (this.layout === "table") this.renderTable(root, cards, opened);
    else if (this.layout === "split") this.renderSplit(root, cards);
    else {
      const list = root.createDiv({ cls: "study-cards-catalog-list" });
      cards.forEach((card) => this.renderCard(list, card, this.cardKey(card), opened.has(this.cardKey(card))));
    }
  }

  private renderTable(root: HTMLElement, cards: Card[], opened: Set<string | null>) {
    const table = root.createDiv({ cls: "study-cards-catalog-table" });
    const header = table.createDiv({ cls: "study-cards-table-row study-cards-table-header", attr: { "aria-hidden": "true" } });
    ["№", "Вопрос", "Заметка", "Статус освоения"].forEach((label) => header.createSpan({ text: label }));
    cards.forEach((card, index) => {
      const key = this.cardKey(card);
      const details = table.createEl("details", { cls: "study-cards-item", attr: { "data-card": key } });
      const summary = details.createEl("summary", { cls: "study-cards-table-row" });
      summary.createSpan({ text: String(index + 1), cls: "study-cards-muted" });
      summary.createSpan({ text: card.question });
      summary.createSpan({ text: card.path, cls: "study-cards-muted study-cards-table-path" });
      this.renderCardSummary(summary, card);
      const body = details.createDiv();
      let rendered = false;
      const expand = () => {
        if (!details.open || rendered) return;
        rendered = true;
        this.renderCardBody(body, card);
      };
      details.ontoggle = expand;
      details.open = opened.has(key);
      expand();
    });
  }

  private renderSplit(root: HTMLElement, cards: Card[]) {
    const selected = cards.find((card) => this.cardKey(card) === this.selected) ?? cards[0]!;
    const split = root.createDiv({ cls: "study-cards-catalog-split" });
    const list = split.createDiv({ cls: "study-cards-split-list" });
    cards.forEach((card) => {
      const button = list.createEl("button", {
        text: card.question, attr: { "aria-pressed": String(card === selected) },
      });
      button.onclick = () => {
        this.selected = this.cardKey(card);
        const scroll = list.scrollTop;
        this.render();
        const next = root.querySelector<HTMLElement>(".study-cards-split-list");
        if (!next) return;
        next.scrollTop = scroll;
        next.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus({ preventScroll: true });
      };
    });
    const detail = split.createDiv({ cls: "study-cards-catalog-detail" });
    detail.createEl("h3", { text: selected.question });
    this.renderCardSummary(detail, selected);
    this.renderCardBody(detail, selected);
  }

  protected renderCardSummary(root: HTMLElement, card: Card) {
    root.createSpan({
      cls: "study-cards-status",
      text: card.status === "invalid" ? "Некорректный статус" : statuses[card.status],
      attr: { "data-status": card.status },
    });
  }

  protected renderCardBody(root: HTMLElement, card: Card) {
    if (isCheckCard(card)) {
      const sectionId = this.study.activeSection!;
      const section = this.study.sections.find(({ id }) => id === sectionId)!;
      root.createEl("button", { text: "Начать с этой карточки", cls: "study-cards-start-here" }).onclick =
        () => this.setup(sectionId, section.name, card.id);
    }
    super.renderCardBody(root, card);
  }

  private setup(sectionId: string, name: string, start?: string) {
    const open = () => {
      const cards = catalogCards(this.study, sectionId).filter(isCheckCard);
      new SetupModal(this.app, name, cards, start, (selected) =>
        this.showCheck(new Check(sectionId, name, selected)), () => this.focus("catalog")).open();
    };
    this.replaceCheck(open);
  }

  private replaceCheck(launch: () => void) {
    const active = this.checks.active;
    if (!active) {
      launch();
      return;
    }
    new CheckModal(this.app, "Есть незавершённая проверка", active.sectionName + " · оценено "
      + active.graded + " из " + active.questions.length + ". При запуске новой проверки текущие оценки будут сброшены.", [
      { label: "Настроить новую", action: launch },
      { label: "Продолжить текущую", action: () => this.showCheck(active), primary: true },
    ]).open();
  }

  private showCheck(check: Check) {
    this.checks.active = check;
    this.shownCheck = check;
    this.report = undefined;
    this.render();
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
  }

  protected renderAlternateScreen(root: HTMLElement) {
    root.toggleClass("study-cards-in-check", Boolean(this.shownCheck));
    root.addClass("study-cards-prototype");
    if (this.shownCheck) this.renderCheck(root, this.shownCheck);
    else if (this.report) this.renderReport(root, this.report);
    return Boolean(this.shownCheck || this.report);
  }

  private renderCheck(root: HTMLElement, check: Check) {
    const card = this.study.cards(check.sectionId).filter(isCheckCard).find(({ id }) => id === check.current.id);
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
    body.createEl("h1", { text: card?.question ?? check.current.question, attr: { tabindex: "-1", "data-focus": "question" } });
    if (!card) {
      body.createEl("p", { text: "Карточка недоступна. Можно перейти дальше.", cls: "study-cards-empty" });
    } else {
      body.createEl("button", { text: card.path, cls: "study-cards-note-link" }).onclick = () => this.perform(this.openNote(card.path));
      if (revealed) {
        const answer = body.createDiv({ cls: "study-cards-answer" });
        answer.createEl("h2", { text: "Эталон", attr: { tabindex: "-1", "data-focus": "answer" } });
        if (this.updated) answer.createEl("p", { text: "Эталон обновлён из заметки", cls: "study-cards-muted" });
        const scrollTop = this.scrollTop;
        void this.renderMarkdown(answer.createDiv({ cls: "markdown-rendered" }), card).then(() => {
          if (scrollTop && body.isConnected) body.scrollTop = scrollTop;
        });
      } else {
        body.createEl("p", { text: "Вспомните ответ, затем сравните его с эталоном.", cls: "study-cards-muted" });
      }
    }

    const footer = panel.createDiv({ cls: "study-cards-check-footer" });
    const gradeBar = footer.createDiv({ cls: "study-cards-grade-bar" });
    const nav = footer.createDiv({ cls: "study-cards-check-nav" });
    const back = nav.createEl("button", { text: "Назад", attr: { "data-focus": "back" } });
    back.disabled = check.position === 0;
    back.onclick = () => this.move(check, -1);
    nav.createEl("button", { text: "Завершить", attr: { "data-focus": "finish" } }).onclick =
      () => this.confirmFinish(check, "finish");
    const last = check.position === check.questions.length - 1;
    const next = nav.createEl("button", {
      text: last ? "К итогу" : "Далее", cls: "mod-cta", attr: { "data-focus": "next" },
    });
    next.disabled = Boolean(card && !check.current.grade && check.position === check.reached);
    next.onclick = () => last ? this.confirmFinish(check, "next") : this.move(check, 1);

    if (card && !revealed) {
      const reveal = gradeBar.createEl("button", {
        text: "Показать эталон", cls: "mod-cta", attr: { "data-focus": "reveal", "aria-keyshortcuts": "Space" },
      });
      reveal.onclick = () => {
        check.revealed.add(card.id);
        this.render();
        this.focus("answer");
      };
      footer.createEl("p", { text: "Пробел — раскрыть эталон", cls: "study-cards-shortcuts" });
      this.bindKeys(panel, { " ": reveal, ArrowLeft: back, ArrowRight: next });
    } else if (card) {
      const correct = this.gradeButton(gradeBar, check, card, "correct", "Верно", "1");
      const wrong = this.gradeButton(gradeBar, check, card, "wrong", "Ошибка", "2");
      footer.createEl("p", { text: "1 — верно · 2 — ошибка · ← → — навигация", cls: "study-cards-shortcuts" });
      this.bindKeys(panel, { "1": correct, "2": wrong, ArrowLeft: back, ArrowRight: next });
    } else {
      gradeBar.hidden = true;
      if (check.current.grade) footer.createEl("p", {
        text: "Оценка сохранена: " + (check.current.grade === "correct" ? "верно" : "ошибка"), cls: "study-cards-muted",
      });
      this.bindKeys(panel, { ArrowLeft: back, ArrowRight: next });
    }
  }

  private move(check: Check, direction: -1 | 1) {
    check.move(direction);
    this.render();
    this.focus("question");
  }

  private gradeButton(root: HTMLElement, check: Check, card: CheckCard, grade: Grade, text: string, key: string) {
    const button = root.createEl("button", { text, attr: {
      "aria-pressed": String(check.current.grade === grade), "aria-keyshortcuts": key, "data-focus": grade, "data-grade": grade,
    } });
    button.onclick = () => {
      check.rate(card, grade);
      this.render();
      this.focus(grade);
    };
    return button;
  }

  private bindKeys(root: HTMLElement, keys: Record<string, HTMLButtonElement>) {
    root.onkeydown = (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
      const target = event.target as HTMLElement;
      if (target.closest("a, input, select, textarea, summary, [contenteditable]")
        || (event.key === " " && target.closest("button"))) return;
      const button = keys[event.key];
      if (!button || button.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      button.click();
    };
  }

  private confirmFinish(check: Check, focus: string) {
    const summary = "Оценено " + check.graded + " из " + check.questions.length
      + ". Без оценки: " + check.ungraded + ".";
    new CheckModal(this.app, "Подтвердить итог?", summary, [{
      label: "Подтвердить итог", primary: true, action: () => {
        this.checks.finish(check);
        this.showReport(check);
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
      retry.onclick = () => this.replaceCheck(() => {
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
