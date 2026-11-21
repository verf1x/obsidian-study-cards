import { Notice, type App } from "obsidian";
import { CheckPrompt, CheckSetupModal } from "./free-check-modals";
import { canAdvance, checkScore, isCheckCard, type CheckCard, type CheckSelection } from "./free-check";
import { message } from "./source-modals";
import type { Card, StudyCards } from "./study-cards";
import type { FreeGrade, FreeResult, FreeSession } from "./study-state";

type Screen = { mode: "check"; id: string } | { mode: "result"; id: string; empty?: FreeResult };

function checkName(check: FreeSession | FreeResult) {
  return check.retryOf === null ? "Свободная проверка" : "Повтор ошибок";
}

function coverage(graded: number, total: number) { return `Оценено ${graded} из ${total}`; }

export class FreeCheckView {
  private screen?: Screen;
  private revealSession?: string;
  private readonly revealed = new Set<string>();
  private answer?: { id: string; card: CheckCard; updated: boolean };
  private answerScroll = 0;
  private saving = false;

  constructor(private readonly app: App, private readonly study: StudyCards, private readonly root: HTMLElement,
    private readonly render: () => void, private readonly renderMarkdown: (root: HTMLElement, card: Card) => Promise<void>) {}

  renderCatalog(root: HTMLElement, sectionId: string, name: string, opened: Set<string | null>) {
    const { session, results } = this.study.freeChecks;
    const actions = root.createDiv({ cls: "study-cards-controls study-cards-free-actions" });
    if (session) actions.createEl("button", { text: "Продолжить проверку", cls: "mod-cta" }).onclick = () => this.showCheck(session.id);
    const start = actions.createEl("button", { text: "Свободная проверка", cls: session ? undefined : "mod-cta" });
    start.disabled = this.blocked() || !this.study.cards(sectionId).some(isCheckCard);
    start.onclick = () => this.setup(sectionId, name);

    const history = results.filter((result) => result.sectionId === sectionId).reverse();
    if (!history.length) return;
    const details = root.createEl("details", { cls: "study-cards-item", attr: { "data-card": "check-history" } });
    details.open = opened.has("check-history");
    details.createEl("summary", { text: "История проверок · " + history.length });
    for (const result of history) {
      const { correct, graded } = checkScore(result, new Set());
      const date = new Date(result.finishedAt).toLocaleString();
      const row = details.createDiv({ cls: "study-cards-controls" });
      row.createEl("button", { text: checkName(result) + " · " + date }).onclick = () => this.showResult(result.id);
      row.createSpan({ text: `${coverage(graded, result.cardIds.length)} · верно ${correct}` });
    }
  }

  renderCardAction(root: HTMLElement, card: Card, sectionId: string, name: string) {
    if (!isCheckCard(card)) return;
    const start = root.createEl("button", { text: "Начать с этой карточки" });
    start.disabled = this.blocked();
    start.onclick = () => this.setup(sectionId, name, card.id);
  }

  renderScreen(root: HTMLElement) {
    if (!this.screen) return false;
    const { revision, session, results } = this.study.freeChecks;
    const { id } = this.screen;
    if (this.screen.mode === "check" && session?.id === id) {
      this.renderCheck(root, session, revision);
      return true;
    }
    if (this.screen.mode === "check" && this.saving) return true;
    if (this.screen.mode === "result") {
      const result = results.find((item) => item.id === id) ?? this.screen.empty;
      if (result) {
        this.renderResult(root, result);
        return true;
      }
    }
    this.screen = undefined;
    return false;
  }

  private blocked() {
    const { saving, problem } = this.study.persistence;
    return this.saving || saving || Boolean(problem);
  }

  private focus(selector: string) { this.root.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true }); }

  private showCheck(id: string) {
    if (this.revealSession !== id) {
      this.revealSession = id;
      this.revealed.clear();
    }
    this.screen = { mode: "check", id };
    this.render();
    this.focus(".study-cards-free-question");
  }

  private showResult(id: string, empty?: FreeResult) {
    this.answer = undefined;
    this.screen = { mode: "result", id, empty };
    this.render();
    this.focus(".study-cards-free-title");
  }

  private catalog() {
    this.screen = this.answer = undefined;
    this.render();
    this.focus(".study-cards-free-actions button:not(:disabled)");
  }

  private sectionName(sectionId: string) {
    return this.study.sections.find(({ id }) => id === sectionId)?.name ?? "Учебный раздел недоступен";
  }

  private setup(sectionId: string, name: string, start?: string) {
    this.replaceCheck((previousId) => {
      new CheckSetupModal(this.app, { id: sectionId, name }, start,
        () => this.study.sections.some(({ id }) => id === sectionId) ? this.study.cards(sectionId, "source").filter(isCheckCard) : [],
        (update) => this.study.subscribe(update),
        (selection) => this.start(previousId, selection)).open();
    });
  }

  private replaceCheck(launch: (previousId: string | null) => void) {
    const { session } = this.study.freeChecks;
    if (!session) return launch(null);
    const summary = coverage(Object.keys(session.grades).length, session.cardIds.length);
    const prompt = `${this.sectionName(session.sectionId)} · ${summary}. При запуске новой проверки текущий результат не сохранится.`;
    new CheckPrompt(this.app, "Есть незавершённая проверка", prompt, [
      { label: "Продолжить текущую", action: () => this.showCheck(session.id), primary: true },
      { label: "Отказаться и начать новую", action: () => launch(session.id) },
    ]).open();
  }

  private async start(previousId: string | null, selection: CheckSelection) {
    if (this.blocked()) throw new Error("Сейчас данные Study Cards недоступны для записи.");
    const id = globalThis.crypto.randomUUID();
    const { revision } = this.study.freeChecks;
    this.saving = true;
    try {
      await this.study.startFreeCheck({ id, revision }, previousId, selection, new Date().toISOString());
    } finally {
      this.saving = false;
      this.render();
    }
    this.showCheck(id);
  }

  private renderCheck(root: HTMLElement, session: FreeSession, revision: string | null) {
    const question = this.study.freeCheckQuestions()[session.position]!;
    const { card, grade, id } = question;
    const shown = this.revealed.has(id);
    const previous = this.answer;
    if (previous?.id !== id) this.answerScroll = 0;
    if (card && shown) {
      const updated = previous?.id === id && (previous.updated
        || previous.card.answer !== card.answer || previous.card.question !== card.question);
      this.answer = { id, card, updated };
    } else this.answer = undefined;

    const panel = root.createDiv({ cls: "study-cards-free-panel", attr: { "aria-label": checkName(session) } });
    const header = panel.createDiv({ cls: "study-cards-controls study-cards-free-header" });
    header.createEl("strong", { text: checkName(session) + " · " + this.sectionName(session.sectionId) });
    header.createEl("button", { text: "К каталогу" }).onclick = () => this.catalog();
    const graded = Object.keys(session.grades).length;
    panel.createEl("p", { text: `Вопрос ${session.position + 1} из ${session.cardIds.length} · ${coverage(graded, session.cardIds.length)}` });
    const body = panel.createDiv({ cls: "study-cards-free-body" });
    body.createEl("h2", { cls: "study-cards-free-question", text: card?.question ?? "Карточка недоступна",
      attr: { tabindex: "-1" } });
    if (card && shown) this.renderAnswer(body, card);
    if (!card) body.createEl("p", { text: "Можно перейти дальше." });
    if (grade && (!card || !shown)) body.createEl("p", { text: "Оценка: " + (grade === "correct" ? "Верно" : "Ошибка") });

    const footer = panel.createDiv({ cls: "study-cards-free-footer" });
    if (card) this.renderGrading(footer, card, grade, session, revision);
    const navigation = footer.createDiv({ cls: "study-cards-controls" });
    const back = navigation.createEl("button", { text: "Назад" });
    back.disabled = this.blocked() || session.position === 0;
    back.onclick = () => this.move(session, revision, -1);
    if (session.position + 1 < session.cardIds.length) {
      const next = navigation.createEl("button", { text: "Далее", cls: "mod-cta" });
      next.disabled = this.blocked() || !canAdvance(session, Boolean(card));
      next.onclick = () => this.move(session, revision, 1);
    }
    const finish = navigation.createEl("button", { text: "Завершить" });
    finish.disabled = this.blocked();
    finish.onclick = () => this.confirmFinish(session, revision);
  }

  private renderAnswer(body: HTMLElement, card: CheckCard) {
    body.createEl("h3", { text: "Ответ", cls: "study-cards-free-answer-title", attr: { tabindex: "-1" } });
    if (this.answer?.updated) body.createEl("p", { text: "Вопрос или ответ обновлён в заметке", attr: { role: "status" } });
    const scroll = this.answerScroll;
    void this.renderMarkdown(body.createDiv({ cls: "study-cards-free-answer" }), card).then(() => {
      if (body.isConnected) body.scrollTop = scroll;
    });
    body.onscroll = () => { if (body.isConnected) this.answerScroll = body.scrollTop; };
  }

  private renderGrading(root: HTMLElement, card: CheckCard, grade: FreeGrade | null, session: FreeSession, revision: string | null) {
    const actions = root.createDiv({ cls: "study-cards-controls study-cards-free-grades" });
    if (!this.revealed.has(card.id)) {
      actions.createEl("button", { text: "Показать ответ", cls: "mod-cta" }).onclick = () => {
        this.revealed.add(card.id);
        this.render();
        this.focus(".study-cards-free-answer-title");
      };
      return;
    }
    for (const [value, label] of [["correct", "Верно"], ["incorrect", "Ошибка"]] as const) {
      const button = actions.createEl("button", { text: label, attr: { "aria-pressed": String(grade === value), "data-grade": value } });
      button.disabled = this.blocked();
      button.onclick = () => this.perform(
        () => this.study.gradeFreeCheck({ id: globalThis.crypto.randomUUID(), revision }, session.id, card, value),
        () => this.renderAndFocus(`[data-grade="${value}"]`));
    }
  }

  private move(session: FreeSession, revision: string | null, direction: -1 | 1) {
    this.perform(() => this.study.moveFreeCheck({ id: globalThis.crypto.randomUUID(), revision }, session.id, direction),
      () => this.renderAndFocus(".study-cards-free-question"));
  }

  private confirmFinish(session: FreeSession, revision: string | null) {
    const graded = Object.keys(session.grades).length;
    const ungraded = session.cardIds.length - graded;
    const prompt = `${coverage(graded, session.cardIds.length)}. Без оценки: ${ungraded}.`;
    new CheckPrompt(this.app, "Подтвердить итог?", prompt, [{
      label: "Подтвердить итог", primary: true, action: () => {
        const finishedAt = new Date().toISOString();
        this.perform(() => this.study.finishFreeCheck({ id: globalThis.crypto.randomUUID(), revision }, session.id, finishedAt),
          () => {
            if (graded) return this.showResult(session.id);
            const available = new Set(this.study.cards(session.sectionId).filter(isCheckCard).map(({ id }) => id));
            const { unavailable } = checkScore(session, available);
            this.showResult(session.id, { ...session, finishedAt, ungradedUnavailable: unavailable });
          });
      },
    }]).open();
  }

  private renderResult(root: HTMLElement, result: FreeResult) {
    const cards = new Map(this.study.cards(result.sectionId).filter(isCheckCard).map((card) => [card.id, card]));
    const { correct, graded, mistakes, ungraded, unavailable } = checkScore(result, new Set(cards.keys()));
    const report = root.createDiv({ cls: "study-cards-free-report" });
    report.createEl("h2", { text: "Итог · " + checkName(result), cls: "study-cards-free-title", attr: { tabindex: "-1" } });
    report.createEl("p", { text: this.sectionName(result.sectionId) });
    const score = report.createDiv({ cls: "study-cards-free-score" });
    const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
    score.createEl("strong", { text: graded ? percent.format(correct / graded) + " верных" : "Нет оценённых ответов" });
    score.createEl("p", { text: coverage(graded, result.cardIds.length) });
    const counts = report.createEl("ul");
    for (const [label, count] of [
      ["Верно", correct], ["Ошибки", mistakes.length],
      ["Без оценки, доступны", ungraded - unavailable], ["Без оценки, недоступны", unavailable],
    ]) counts.createEl("li", { text: `${label} · ${count}` });

    if (mistakes.length) {
      report.createEl("h3", { text: "Вопросы с ошибками" });
      const list = report.createEl("ol");
      for (const id of mistakes) list.createEl("li", {
        text: cards.get(id)?.question ?? `Карточка недоступна · вопрос ${result.cardIds.indexOf(id) + 1}`,
      });
    }
    const actions = report.createDiv({ cls: "study-cards-controls" });
    if (mistakes.length) {
      const canRetry = mistakes.some((id) => cards.has(id));
      if (!canRetry) report.createEl("p", { text: "Все вопросы с ошибками недоступны." });
      const retry = actions.createEl("button", { text: "Повтор ошибок", cls: "mod-cta" });
      retry.disabled = this.blocked() || !canRetry;
      retry.onclick = () => this.replaceCheck((previous) => {
        void this.start(previous, { retryOf: result.id }).catch((error) => new Notice(message(error)));
      });
    }
    actions.createEl("button", { text: "К каталогу" }).onclick = () => this.catalog();
  }

  private perform(action: () => Promise<void>, after: () => void) {
    if (this.blocked()) return;
    const screen = this.screen;
    this.saving = true;
    this.render();
    void action().then(() => {
      this.saving = false;
      if (this.screen === screen) after();
      else this.render();
    }).catch((error) => {
      this.saving = false;
      this.render();
      new Notice(message(error));
    });
  }

  private renderAndFocus(selector: string) {
    this.render();
    this.focus(selector);
  }
}
