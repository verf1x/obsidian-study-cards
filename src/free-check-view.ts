import { Notice, setIcon, type App } from "obsidian";
import { CheckPrompt } from "./free-check-modals";
import { FreeCheckSetup } from "./free-check-setup";
import { canAdvance, checkScore, isCheckCard, type CheckCard, type CheckSelection } from "./free-check";
import { localization, t } from "./localization";
import { renderPaneAction } from "./pane-action";
import { message } from "./source-modals";
import type { Card, StudyCards } from "./study-cards";
import type { FreeGrade, FreeResult, FreeSession } from "./study-state";

type Screen = { mode: "setup"; form: FreeCheckSetup }
  | { mode: "check"; id: string }
  | { mode: "result"; id: string; empty?: FreeResult };

function checkName(check: FreeSession | FreeResult) {
  return check.retryOf === null ? t("freeCheck") : t("mistakeRetry");
}

export class FreeCheckView {
  private screen?: Screen;
  private revealSession?: string;
  private readonly revealed = new Set<string>();
  private answer?: { id: string; card: CheckCard; updated: boolean };
  private answerScroll = 0;
  private saving = false;

  constructor(private readonly app: App, private readonly study: StudyCards, private readonly root: HTMLElement,
    private readonly render: () => void, private readonly renderMarkdown: (root: HTMLElement, card: Card) => Promise<void>,
    private readonly backToPractice: () => void, private readonly onCheckStarted: (sectionId: string) => void) {}

  close() { this.screen = undefined; }

  get settingUp() { return this.screen?.mode === "setup"; }

  dismissSetup() {
    if (!this.settingUp) return true;
    if (this.saving) return false;
    this.close();
    return true;
  }

  renderPractice(root: HTMLElement, toolbar: HTMLElement, sectionId: string, name: string, introductory: boolean,
    openNotes: () => void) {
    const { session } = this.study.freeChecks;
    const cards = this.study.cards(sectionId);
    if (session) {
      const resume = root.createDiv({ cls: "study-cards-practice-resume" });
      const label = resume.createDiv();
      label.createEl("strong", { text: checkName(session) });
      const position = t("checkPosition", { position: session.position + 1, total: session.cardIds.length });
      label.createEl("p", { text: session.sectionId === sectionId ? position : `${this.sectionName(session.sectionId)} · ${position}` });
      const button = resume.createEl("button", { cls: "mod-cta", attr: { "data-focus": "check-continue" } });
      setIcon(button.createSpan({ cls: "study-cards-nav-icon", attr: { "aria-hidden": "true" } }), "circle-play");
      button.createSpan({ text: t("continueFreeCheck") });
      button.onclick = () => this.showCheck(session.id);
    }
    const start = (session ? root : toolbar).createEl("button", {
      cls: session ? undefined : "mod-cta study-cards-test-action", attr: { "data-focus": "check-start" },
    });
    if (session) renderPaneAction(start, "circle-play", t("newFreeCheck"), "");
    else {
      setIcon(start.createSpan({ cls: "study-cards-nav-icon", attr: { "aria-hidden": "true" } }), "circle-play");
      start.createSpan({ text: t("testYourself") });
    }
    const eligible = cards.some(isCheckCard);
    start.disabled = this.blocked() || !eligible;
    start.onclick = () => this.setup(sectionId, name, { focus: "check-start", introductory });
    if (!eligible) {
      const actions = root.createDiv({ cls: "study-cards-practice-row" });
      actions.createEl("p", { text: t(cards.length ? "sectionWithoutEligibleCards" : "sectionWithoutCards") });
      actions.createEl("button", { text: t("notes") }).onclick = openNotes;
    }
    const history = this.study.freeChecks.results.filter((result) => result.sectionId === sectionId);
    const latest = history[history.length - 1];
    if (latest) {
      const available = new Set(cards.filter(isCheckCard).map(({ id }) => id));
      const { mistakes } = checkScore(latest, available);
      if (mistakes.some((id) => available.has(id))) {
        const retry = root.createEl("button");
        renderPaneAction(retry, "rotate-cw", t("retryMistakes"), t("sectionCardCount", { count: mistakes.length }));
        retry.disabled = this.blocked();
        retry.onclick = () => this.retry(latest);
      }
    }
  }

  renderHistory(root: HTMLElement, sectionId: string, opened: Set<string | null>) {
    const { results } = this.study.freeChecks;
    const history = results.filter((result) => result.sectionId === sectionId).reverse();
    const latest = history[0];
    const details = root.createEl("details", { attr: { "data-card": "check-history" } });
    details.open = opened.has("check-history");
    const visibleHistory = details.createEl("summary");
    const latestScore = latest ? checkScore(latest, new Set()) : undefined;
    renderPaneAction(visibleHistory, "history", t("checkHistory"), latestScore && latest
      ? t("checkHistoryScore", { graded: latestScore.graded, total: latest.cardIds.length, correct: latestScore.correct })
      : t("noCheckResults"));
    for (const result of history) {
      const { correct, graded } = checkScore(result, new Set());
      const date = localization.date(result.finishedAt);
      const row = details.createEl("button");
      renderPaneAction(row, "file-check", t("checkHistoryEntry", { check: checkName(result), date }),
        t("checkHistoryScore", { graded, total: result.cardIds.length, correct }));
      row.onclick = () => this.showResult(result.id);
    }
  }

  renderCardAction(root: HTMLElement, card: Card, sectionId: string, name: string) {
    if (!isCheckCard(card)) return;
    const focus = `check-start:${card.id}`;
    const start = root.createEl("button", { text: t("startFromCard"), attr: { "data-focus": focus } });
    start.disabled = this.blocked();
    start.onclick = () => this.setup(sectionId, name, { focus, start: card });
  }

  refreshSetup() {
    const screen = this.screen;
    if (screen?.mode !== "setup" || !this.root.contains(screen.form.root)) return false;
    const { problem, saving } = this.study.persistence;
    screen.form.refresh(Boolean(problem), saving);
    return true;
  }

  renderScreen(root: HTMLElement) {
    if (!this.screen) return false;
    if (this.screen.mode === "setup") {
      root.append(this.screen.form.root);
      return this.refreshSetup();
    }
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

  private practice() {
    this.screen = this.answer = undefined;
    this.backToPractice();
  }

  private sectionName(sectionId: string) {
    return this.study.sections.find(({ id }) => id === sectionId)?.name ?? t("sectionUnavailable");
  }

  private setup(sectionId: string, name: string,
    { focus, start, introductory = false }: { focus: string; start?: CheckCard; introductory?: boolean }) {
    this.replaceCheck((previousId) => {
      const container = this.root.ownerDocument.createElement("div");
      const form = new FreeCheckSetup(container, { id: sectionId, name }, start, introductory,
        () => this.study.cards(sectionId, "source").filter(isCheckCard),
        () => {
          this.screen = undefined;
          this.render();
          const target = this.root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focus)}"]`)
            ?? this.root.querySelector<HTMLElement>('[data-focus="cards-heading"], [data-focus="practice"]');
          target?.focus();
        },
        (selection) => this.start(previousId, selection));
      this.screen = { mode: "setup", form };
      this.render();
      form.focus();
    });
  }

  private replaceCheck(launch: (previousId: string | null) => void) {
    const { session } = this.study.freeChecks;
    if (!session) return launch(null);
    const prompt = t("replaceFreeCheck", {
      section: this.sectionName(session.sectionId), graded: Object.keys(session.grades).length, total: session.cardIds.length,
    });
    new CheckPrompt(this.app, t("unfinishedCheckExists"), prompt, [
      { label: t("resumeCurrentCheck"), action: () => this.showCheck(session.id), primary: true },
      { label: t("discardAndStart"), action: () => launch(session.id) },
    ]).open();
  }

  private async start(previousId: string | null, selection: CheckSelection) {
    if (this.blocked()) throw new Error(t("currentlyReadOnly"));
    const id = globalThis.crypto.randomUUID();
    const { revision } = this.study.freeChecks;
    this.saving = true;
    try {
      await this.study.startFreeCheck({ id, revision }, previousId, selection, new Date().toISOString());
    } catch (error) {
      this.saving = false;
      this.render();
      throw error;
    }
    this.saving = false;
    if ("sectionId" in selection) this.onCheckStarted(selection.sectionId);
    this.showCheck(id);
  }

  private retry(result: FreeResult) {
    if (this.blocked()) return;
    this.replaceCheck((previous) => {
      void this.start(previous, { retryOf: result.id }).catch((error) => new Notice(message(error)));
    });
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
    const exit = header.createEl("button", { cls: "study-cards-quiet-button" });
    setIcon(exit.createSpan({ cls: "study-cards-nav-icon", attr: { "aria-hidden": "true" } }), "arrow-left");
    exit.createSpan({ text: t("backToPractice") });
    exit.onclick = () => this.practice();
    const { correct, mistakes, graded } = checkScore(session, new Set());
    const position = t("checkPosition", { position: session.position + 1, total: session.cardIds.length });
    header.createEl("p", { cls: "study-cards-free-progress", text: position });
    const progress = panel.createDiv({ cls: "study-cards-progress-strip", attr: {
      role: "img", "aria-label": [
        t("checkQuestionProgress", { position: session.position + 1, total: session.cardIds.length, graded }),
        t("correctCount", { count: correct }),
        t("mistakeCount", { count: mistakes.length }),
      ].join(". "),
    } });
    for (const [index, cardId] of session.cardIds.entries()) {
      progress.createSpan({ attr: { "data-current": String(index === session.position), "data-grade": session.grades[cardId] ?? "" } });
    }
    const body = panel.createDiv({ cls: "study-cards-free-body" });
    body.createEl("h2", { cls: "study-cards-free-question", text: card?.question ?? t("cardUnavailable"),
      attr: { tabindex: "-1" } });
    if (card) body.createEl("p", { cls: "study-cards-question-source", text: card.path });
    if (card && shown) this.renderAnswer(body, card);
    if (card && !shown) {
      const reveal = body.createDiv({ cls: "study-cards-reveal-row" });
      const button = reveal.createEl("button", { text: t("revealAnswer"), cls: "mod-cta" });
      button.onclick = () => {
        this.revealed.add(card.id);
        this.render();
        this.focus(".study-cards-free-answer-title");
      };
      reveal.createEl("p", { text: t("recallPrompt") });
    }
    if (!card) body.createEl("p", { text: t("canSkipQuestion") });
    if (grade && (!card || !shown)) body.createEl("p", { text: t("currentGrade", { grade: t(grade) }) });

    const footer = panel.createDiv({ cls: "study-cards-free-footer" });
    if (card && shown) this.renderGrading(footer, card, grade, session, revision);
    const navigation = footer.createDiv({ cls: "study-cards-controls" });
    const back = navigation.createEl("button", { text: t("back") });
    back.disabled = this.blocked() || session.position === 0;
    back.onclick = () => this.move(session, revision, -1);
    if (session.position + 1 < session.cardIds.length) {
      const next = navigation.createEl("button", { text: t("next"), cls: "mod-cta" });
      next.disabled = this.blocked() || !canAdvance(session, Boolean(card));
      next.onclick = () => this.move(session, revision, 1);
    }
    const finish = navigation.createEl("button", { text: t("finish") });
    finish.disabled = this.blocked();
    finish.onclick = () => this.confirmFinish(session, revision);
  }

  private renderAnswer(body: HTMLElement, card: CheckCard) {
    const answer = body.createDiv({ cls: "study-cards-reference-answer" });
    answer.createEl("h3", { text: t("answerFromNote"), cls: "study-cards-free-answer-title", attr: { tabindex: "-1" } });
    if (this.answer?.updated) answer.createEl("p", { text: t("answerUpdated"), attr: { role: "status" } });
    const scroll = this.answerScroll;
    void this.renderMarkdown(answer.createDiv({ cls: "study-cards-free-answer" }), card).then(() => {
      if (body.isConnected) body.scrollTop = scroll;
    });
    body.onscroll = () => { if (body.isConnected) this.answerScroll = body.scrollTop; };
  }

  private renderGrading(root: HTMLElement, card: CheckCard, grade: FreeGrade | null, session: FreeSession, revision: string | null) {
    const actions = root.createDiv({ cls: "study-cards-controls study-cards-free-grades" });
    for (const value of ["correct", "incorrect"] as const) {
      const button = actions.createEl("button", { text: t(value), attr: { "aria-pressed": String(grade === value), "data-grade": value } });
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
    const prompt = t("confirmCheckProgress", { graded, total: session.cardIds.length, ungraded });
    new CheckPrompt(this.app, t("confirmResultPrompt"), prompt, [{
      label: t("confirmResult"), primary: true, action: () => {
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
    report.createEl("h2", { text: t("checkResultHeading", { check: checkName(result) }), cls: "study-cards-free-title", attr: { tabindex: "-1" } });
    report.createEl("p", { text: this.sectionName(result.sectionId) });
    const totals = report.createDiv({ cls: "study-cards-free-totals" });
    for (const [label, count] of [["correct", correct], ["incorrect", mistakes.length], ["ungradedAnswers", ungraded]] as const) {
      const item = totals.createDiv({ attr: { "data-total": label } });
      item.createEl("strong", { text: t("resultTotalValue", { count }) });
      item.createEl("small", { text: t(label) });
    }
    const score = report.createDiv({ cls: "study-cards-free-score" });
    score.createEl("strong", { text: graded ? t("percentCorrect", { percent: localization.percent(correct / graded) }) : t("noGradedAnswers") });
    score.createEl("p", { text: t("gradedCoverage", { graded, total: result.cardIds.length }) });
    if (ungraded) score.createEl("p", { text: [t("ungradedAvailableCount", { count: ungraded - unavailable }),
      t("ungradedUnavailableCount", { count: unavailable })].join(" · ") });

    if (mistakes.length) {
      report.createEl("h3", { text: t("mistakeQuestions") });
      const list = report.createEl("ol", { cls: "study-cards-mistake-list" });
      for (const id of mistakes) list.createEl("li", {
        text: cards.get(id)?.question ?? t("numberedUnavailableCard", { position: result.cardIds.indexOf(id) + 1 }),
      });
    }
    const actions = report.createDiv({ cls: "study-cards-controls study-cards-report-actions" });
    actions.createEl("button", { text: t("backToPractice"), cls: "study-cards-quiet-button" }).onclick = () => this.practice();
    if (mistakes.length) {
      const canRetry = mistakes.some((id) => cards.has(id));
      if (!canRetry) report.createEl("p", { text: t("allMistakesUnavailable") });
      const retry = actions.createEl("button", { text: t("retryMistakes"), cls: "mod-cta" });
      retry.disabled = this.blocked() || !canRetry;
      retry.onclick = () => this.retry(result);
    }
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
