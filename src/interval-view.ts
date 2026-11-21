import { Notice } from "obsidian";
import { reviewDue } from "./interval-queue";
import { IntervalSession, type ReviewQuestion } from "./interval-session";
import { localization, t } from "./localization";
import { renderPaneAction } from "./pane-action";
import { message } from "./source-modals";
import type { Card, StudyCards } from "./study-cards";
import type { IntervalReview, ReviewGrade } from "./study-state";

const descriptions = {
  again: "againDescription", hard: "hardDescription", good: "goodDescription", easy: "easyDescription",
} as const satisfies Record<ReviewGrade, string>;

function sameQuestion(previous: ReviewQuestion | undefined, current: ReviewQuestion) {
  const card = previous?.card;
  return card && previous.revision === current.revision
    && card.id === current.card.id && card.path === current.card.path && card.index === current.card.index
    && card.status === current.card.status
    && card.question === current.card.question && card.answer === current.card.answer;
}

type QuestionCheck = { question: ReviewQuestion; state: "checking" | "ready" | "failed" };

export class IntervalView {
  private session?: IntervalSession;
  private revealed?: ReviewQuestion;
  private checked?: QuestionCheck;
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
    this.session = this.revealed = this.checked = undefined;
    this.opening = undefined;
  }

  renderCatalog(root: HTMLElement, sectionId: string) {
    const now = new Date();
    const section = this.study.intervalStatistics(sectionId, now);
    const detail = section.available ? t("availableNow", { count: section.available }) : section.nextDue
      ? t("nextReview", { date: localization.date(section.nextDue) }) : t("noCardsToReview");
    const start = root.createEl("button", { attr: { "data-focus": "interval-start" } });
    renderPaneAction(start, "rotate-cw", t("spacedRepetition"), detail);
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

    const all = this.study.intervalStatistics(null, now);
    this.updateAt(all.dayEndsAt, all.nextDue);
  }

  renderCardAction(root: HTMLElement, card: Card) {
    if (card.identity !== "valid" || card.status === "invalid") return;
    const suspended = Boolean(card.progress?.suspended);
    const button = root.createEl("button", { text: suspended ? t("resumeReviews") : t("suspendReviews") });
    button.disabled = this.blocked();
    const revision = this.study.progressRevision;
    button.onclick = () => this.perform(() =>
      this.study.setSuspended({ id: globalThis.crypto.randomUUID(), revision }, card, !suspended));
    const due = reviewDue(card);
    if (due) root.createSpan({ text: t("reviewDue", { date: localization.date(due) }) });
  }

  renderCardReviews(root: HTMLElement, reviews: readonly IntervalReview[]) {
    const list = root.createEl("ul", { attr: { "aria-label": t("reviewGrades") } });
    for (const { grade, at } of [...reviews].reverse()) {
      list.createEl("li").createEl("time", {
        text: t("reviewHistoryEntry", { grade: t(grade), date: localization.date(at) }),
        attr: { datetime: at },
      });
    }
  }

  renderScreen(root: HTMLElement) {
    const session = this.session;
    if (!session) return false;
    const section = this.study.sections.find(({ id }) => id === session.sectionId);
    if (!section) {
      this.close();
      return false;
    }
    const { question: candidate, undo, available, nextDue } = session.refreshQuestion();
    const check = candidate && this.checkQuestion(candidate);
    if (!candidate) this.checked = undefined;
    const question = check?.state === "ready" ? candidate : undefined;
    if (!candidate || !sameQuestion(this.revealed, candidate)) this.revealed = undefined;
    const stats = this.study.intervalStatistics(section.id, new Date());
    this.updateAt(stats.dayEndsAt, nextDue);

    const panel = root.createDiv({ cls: "study-cards-interval-panel", attr: { "aria-label": t("spacedRepetition") } });
    const header = panel.createDiv({ cls: "study-cards-controls study-cards-interval-header" });
    header.createEl("strong", { text: t("spacedRepetitionSection", { section: section.name }) });
    const back = header.createEl("button", { text: t("backToPractice") });
    back.disabled = this.busy;
    back.onclick = () => {
      this.close();
      this.render();
      this.focus('[data-focus="interval-start"]');
    };
    this.renderStatistics(panel, { ...stats, available });
    const totals = panel.createEl("details", { cls: "study-cards-interval-totals" });
    totals.createEl("summary", { text: t("allSectionReviews") });
    this.renderStatistics(totals, this.study.intervalStatistics(null, new Date()));

    const body = panel.createDiv({ cls: "study-cards-interval-body" });
    const heading = nextDue ? t("waitingForReview") : t("noCardsToReview");
    body.createEl("h2", {
      text: question?.card.question ?? (check ? t("checkingCard") : heading),
      cls: "study-cards-interval-question", attr: { tabindex: "-1" },
    });
    if (!candidate && nextDue) body.createEl("p").createEl("time", {
      text: t("nextReview", { date: localization.date(nextDue) }), attr: { datetime: nextDue.toISOString() },
    });
    const footer = panel.createDiv({ cls: "study-cards-interval-footer" });
    if (check?.state === "failed") {
      footer.createEl("button", { text: t("checkAgain") }).onclick = () => {
        this.checked = undefined;
        this.render();
      };
    }
    if (question) {
      if (this.revealed) {
        body.createEl("h3", { text: t("answer"), cls: "study-cards-interval-answer", attr: { tabindex: "-1" } });
        void this.renderMarkdown(body.createDiv(), question.card);
        this.renderGrades(footer, session, question);
      } else {
        const reveal = footer.createEl("button", { text: t("revealAnswer"), cls: "mod-cta" });
        reveal.onclick = () => {
          this.revealed = question;
          this.render();
          this.focus(".study-cards-interval-answer");
        };
      }
    }
    if (undo) {
      const button = footer.createEl("button", { text: t("undoLastGrade") });
      button.disabled = this.blocked();
      button.onclick = () => this.perform(() => session.undo(undo), ".study-cards-interval-question");
    }
    return true;
  }

  private checkQuestion(question: ReviewQuestion) {
    if (this.checked && sameQuestion(this.checked.question, question)) return this.checked;
    const check: QuestionCheck = { question, state: "checking" };
    this.checked = check;
    void this.study.recheckIntervalSource(question.card.path).then(() => {
      check.state = "ready";
    }).catch((error) => {
      check.state = "failed";
      if (this.checked === check) new Notice(message(error));
    }).finally(() => {
      if (this.checked !== check) return;
      const selector = ".study-cards-interval-question";
      const hadFocus = this.root.querySelector(selector) === this.root.ownerDocument.activeElement;
      this.render();
      if (hadFocus) this.focus(selector);
    });
    return check;
  }

  private renderStatistics(root: HTMLElement, { available, cards, reviews }: ReturnType<StudyCards["intervalStatistics"]>) {
    const row = root.createDiv({ cls: "study-cards-controls study-cards-interval-statistics" });
    row.createSpan({ text: t("availableNow", { count: available }) });
    row.createSpan({ text: t("cardsReviewedToday", { count: cards }) });
    row.createSpan({ text: t("reviewsGradedToday", { count: reviews }) });
  }

  private renderGrades(root: HTMLElement, session: IntervalSession, question: ReviewQuestion) {
    const intervals = session.intervals(question);
    const row = root.createDiv({ cls: "study-cards-interval-grades" });
    for (const grade of Object.keys(descriptions) as ReviewGrade[]) {
      const button = row.createEl("button", { cls: grade === "good" ? "mod-cta" : undefined,
        attr: { title: t(descriptions[grade]), "data-interval-grade": grade } });
      button.createSpan({ text: t(grade) });
      button.createEl("small", { text: localization.interval(intervals[grade]) });
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
      this.checked = undefined;
      this.render();
      new Notice(message(error));
    });
  }
}
