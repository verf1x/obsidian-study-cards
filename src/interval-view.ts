import { Notice } from "obsidian";
import { reviewDue } from "./interval-queue";
import { IntervalSession, type ReviewQuestion } from "./interval-session";
import { message } from "./source-modals";
import type { Card, StudyCards } from "./study-cards";
import type { ReviewGrade } from "./study-state";

const grades: ReadonlyArray<[ReviewGrade, string, string]> = [
  ["again", "Снова", "Ответ забыт"],
  ["hard", "Трудно", "Верный ответ с усилием"],
  ["good", "Хорошо", "Обычный верный ответ"],
  ["easy", "Легко", "Уверенный ответ без усилия"],
];

function formatInterval(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} мин`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toLocaleString(undefined, { maximumFractionDigits: 1 })} ч`;
  return `${(hours / 24).toLocaleString(undefined, { maximumFractionDigits: 1 })} дн`;
}

function sameQuestion(previous: ReviewQuestion | undefined, current: ReviewQuestion) {
  const card = previous?.card;
  return card && previous.revision === current.revision
    && card.id === current.card.id && card.path === current.card.path && card.status === current.card.status
    && card.question === current.card.question && card.answer === current.card.answer;
}

export class IntervalView {
  private session?: IntervalSession;
  private revealed?: ReviewQuestion;
  private busy = false;
  private opening?: Promise<IntervalSession>;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly study: StudyCards, private readonly root: HTMLElement,
    private readonly render: () => void, private readonly renderMarkdown: (root: HTMLElement, card: Card) => Promise<void>) {}

  clearTimer() {
    clearTimeout(this.timer);
  }

  close() {
    this.clearTimer();
    this.session = this.revealed = undefined;
    this.opening = undefined;
  }

  renderCatalog(root: HTMLElement, sectionId: string, opened: Set<string | null>) {
    const now = new Date();
    const block = root.createDiv({ cls: "study-cards-free-actions" });
    const start = block.createEl("button", { text: "Интервальное повторение", attr: { "data-focus": "interval-start" } });
    start.disabled = this.blocked();
    start.onclick = () => this.perform(async () => {
      const opening = IntervalSession.start(this.study, sectionId);
      this.opening = opening;
      try {
        const session = await opening;
        if (this.opening === opening) this.session = session;
      } finally {
        if (this.opening === opening) this.opening = undefined;
      }
    }, ".study-cards-interval-question");

    const section = this.study.intervalStatistics(sectionId, now);
    this.renderStatistics(block, section);
    const all = this.study.intervalStatistics(null, now);
    const totals = block.createEl("details", { attr: { "data-card": "interval-statistics" } });
    totals.open = opened.has("interval-statistics");
    totals.createEl("summary", { text: "Повторения во всех учебных разделах" });
    this.renderStatistics(totals, all);
    this.updateAt(all.dayEndsAt, all.nextDue);
  }

  renderCardAction(root: HTMLElement, card: Card) {
    if (card.identity !== "valid" || card.status === "invalid") return;
    const suspended = Boolean(card.progress?.suspended);
    const button = root.createEl("button", { text: suspended ? "Возобновить повторения" : "Приостановить повторения" });
    button.disabled = this.blocked();
    const revision = this.study.progressRevision;
    button.onclick = () => this.perform(() =>
      this.study.setSuspended({ id: globalThis.crypto.randomUUID(), revision }, card, !suspended));
    const due = reviewDue(card);
    if (due) root.createSpan({ text: "Срок повторения · " + due.toLocaleString() });
  }

  renderScreen(root: HTMLElement) {
    const session = this.session;
    if (!session) return false;
    const section = this.study.sections.find(({ id }) => id === session.sectionId);
    if (!section) {
      this.close();
      return false;
    }
    const { question, undo, available, nextDue } = session.refreshQuestion();
    if (!question || !sameQuestion(this.revealed, question)) this.revealed = undefined;
    const stats = this.study.intervalStatistics(section.id, new Date());
    this.updateAt(stats.dayEndsAt, nextDue);

    const panel = root.createDiv({ cls: "study-cards-interval-panel", attr: { "aria-label": "Интервальное повторение" } });
    const header = panel.createDiv({ cls: "study-cards-controls study-cards-interval-header" });
    header.createEl("strong", { text: "Интервальное повторение · " + section.name });
    const back = header.createEl("button", { text: "К каталогу" });
    back.disabled = this.busy;
    back.onclick = () => {
      this.close();
      this.render();
      this.focus('[data-focus="interval-start"]');
    };
    this.renderStatistics(panel, { ...stats, available });

    const body = panel.createDiv({ cls: "study-cards-interval-body" });
    body.createEl("h2", {
      text: question?.card.question ?? (nextDue ? "Ожидание повторения" : "Нет карточек для повторения"),
      cls: "study-cards-interval-question", attr: { tabindex: "-1" },
    });
    if (!question && nextDue) body.createEl("p").createEl("time", {
      text: "Следующий повтор · " + nextDue.toLocaleString(), attr: { datetime: nextDue.toISOString() },
    });
    const footer = panel.createDiv({ cls: "study-cards-interval-footer" });
    if (question) {
      if (this.revealed) {
        body.createEl("h3", { text: "Ответ", cls: "study-cards-interval-answer", attr: { tabindex: "-1" } });
        void this.renderMarkdown(body.createDiv(), question.card);
        this.renderGrades(footer, session, question);
      } else {
        const reveal = footer.createEl("button", { text: "Показать ответ", cls: "mod-cta" });
        reveal.onclick = () => {
          this.revealed = question;
          this.render();
          this.focus(".study-cards-interval-answer");
        };
      }
    }
    if (undo) {
      const button = footer.createEl("button", { text: "Отменить последнюю оценку" });
      button.disabled = this.blocked();
      button.onclick = () => this.perform(() => session.undo(undo), ".study-cards-interval-question");
    }
    return true;
  }

  private renderStatistics(root: HTMLElement, { available, cards, reviews }: ReturnType<StudyCards["intervalStatistics"]>) {
    const row = root.createDiv({ cls: "study-cards-controls study-cards-interval-statistics" });
    row.createSpan({ text: "Доступно сейчас · " + available });
    row.createSpan({ text: "Карточек повторено сегодня · " + cards });
    row.createSpan({ text: "Оценок за сегодня · " + reviews });
  }

  private renderGrades(root: HTMLElement, session: IntervalSession, question: ReviewQuestion) {
    const intervals = session.intervals(question);
    const row = root.createDiv({ cls: "study-cards-interval-grades" });
    for (const [grade, label, description] of grades) {
      const button = row.createEl("button", { cls: grade === "good" ? "mod-cta" : undefined,
        attr: { title: description, "data-interval-grade": grade } });
      button.createSpan({ text: label });
      button.createEl("small", { text: formatInterval(intervals[grade]) });
      button.disabled = this.blocked();
      button.onclick = () => this.perform(() => session.grade(question, grade), ".study-cards-interval-question");
    }
  }

  private updateAt(dayEndsAt: number, nextDue: Date | undefined) {
    const next = Math.min(dayEndsAt, nextDue?.getTime() ?? Infinity);
    this.timer = setTimeout(this.render, Math.max(0, next - Date.now()));
  }

  private focus(selector: string) {
    this.root.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  }

  private blocked() {
    const { problem, saving } = this.study.persistence;
    return this.busy || saving || Boolean(problem);
  }

  private perform(action: () => Promise<void>, focus?: string) {
    if (this.blocked()) return;
    this.busy = true;
    const operation = action();
    this.render();
    void operation.then(() => {
      this.revealed = undefined;
      this.busy = false;
      this.render();
      if (focus) this.focus(focus);
    }).catch((error) => {
      this.busy = false;
      this.render();
      new Notice(message(error));
    });
  }
}
