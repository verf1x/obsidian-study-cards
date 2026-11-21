import { DefaultScheduler, Rating, State } from "ts-fsrs";
import { reviewDue, reviewQueue, type ReviewCard } from "./interval-queue";
import type { ProgressMutation, StudyCards } from "./study-cards";
import { isDate, record, type ReviewGrade } from "./study-state";
import { StaleStudyState } from "./study-storage";

const ratings = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy } as const;
type Scheduler = DefaultScheduler<"FSRS-7">;
type SchedulerCard = ReturnType<Scheduler["newCard"]>;
let scheduler: Promise<Scheduler> | undefined;

function loadScheduler() {
  return scheduler ??= DefaultScheduler({
    version: "FSRS-7", learningSteps: ["1m", "10m"], relearningSteps: ["10m"],
    allowModelOverride: true, enableFuzz: false,
  }).catch((error) => {
    scheduler = undefined;
    throw error;
  });
}

function restoreCard(card: ReviewCard, scheduler: Scheduler, now: Date): SchedulerCard {
  const schedule = card.progress?.schedule;
  if (record(schedule) && schedule.model === "FSRS-7" && isDate(schedule.dueAt) && isDate(schedule.lastReviewAt)
    && (schedule.state === State.Learning || schedule.state === State.Review || schedule.state === State.Relearning)
    && (schedule.scheduleStatus === "learning" || schedule.scheduleStatus === "review")
    && typeof schedule.stability === "number" && typeof schedule.stabilityFast === "number"
    && typeof schedule.difficulty === "number" && typeof schedule.reps === "number" && typeof schedule.lapses === "number"
    && typeof schedule.scheduledDays === "number" && typeof schedule.learningStep === "number") {
    return {
      ...schedule, cardId: card.id,
      dueAt: new Date(schedule.dueAt), lastReviewAt: new Date(schedule.lastReviewAt),
      state: schedule.state, scheduleStatus: schedule.scheduleStatus, stability: schedule.stability,
      stabilityFast: schedule.stabilityFast, difficulty: schedule.difficulty, reps: schedule.reps, lapses: schedule.lapses,
      scheduledDays: schedule.scheduledDays, learningStep: schedule.learningStep,
    };
  }
  return { ...scheduler.newCard({ cardId: card.id, now }), dueAt: reviewDue(card) ?? now };
}

export interface ReviewQuestion { card: ReviewCard; revision: string | null }
type UndoTarget = NonNullable<ReturnType<StudyCards["latestIntervalReview"]>>;

export class IntervalSession {
  private currentId?: string;
  private retry?: { key: string; run: () => Promise<void>; pending?: Promise<void> };

  private constructor(private readonly study: StudyCards, readonly sectionId: string,
    private readonly cardIds: ReadonlySet<string>, private readonly scheduler: Scheduler, private readonly clock: () => Date,
    private readonly id = globalThis.crypto.randomUUID()) {}

  static async start(study: StudyCards, sectionId: string, clock = () => new Date()) {
    const cardIds = new Set(study.intervalCards(sectionId).map(({ id }) => id));
    return new IntervalSession(study, sectionId, cardIds, await loadScheduler(), clock);
  }

  refreshQuestion() {
    const cards = this.study.intervalCards(this.sectionId, "source").filter(({ id }) => this.cardIds.has(id));
    const { ready, nextDue } = reviewQueue(cards, this.clock());
    const card = ready.find(({ id }) => id === this.currentId) ?? ready[0];
    this.currentId = card?.id;
    const question: ReviewQuestion | undefined = card && { card, revision: this.study.progressRevision };
    return { question, nextDue, available: ready.length, undo: this.study.latestIntervalReview(this.id) };
  }

  intervals({ card }: ReviewQuestion): Record<ReviewGrade, number> {
    const now = this.clock();
    const preview = [...this.scheduler.preview({ card: restoreCard(card, this.scheduler, now), now })];
    const interval = (grade: ReviewGrade) => preview.find((choice) => choice.grade === ratings[grade])!.card.dueAt.getTime()
      - now.getTime();
    return { again: interval("again"), hard: interval("hard"), good: interval("good"), easy: interval("easy") };
  }

  grade({ card, revision }: ReviewQuestion, grade: ReviewGrade) {
    if (card.id !== this.currentId) return Promise.reject(new StaleStudyState());
    const action = ["grade", grade, card.id, card.path, card.index, card.status, card.question, card.answer];
    return this.write(revision, action, (mutation) => {
      const now = this.clock();
      const { card: updated } = this.scheduler.review({
        card: restoreCard(card, this.scheduler, now), grade: ratings[grade], now,
      });
      const at = now.toISOString();
      const schedule = { ...updated, model: "FSRS-7", dueAt: updated.dueAt.toISOString(), lastReviewAt: at };
      return async () => {
        await this.study.recordReview(mutation, card, { sectionId: this.sectionId, sessionId: this.id, at, grade }, schedule);
        this.currentId = undefined;
      };
    });
  }

  undo({ uuid, reviewId, revision }: UndoTarget) {
    return this.write(revision, ["undo", reviewId], (mutation) => async () => {
      await this.study.undoReview(mutation, uuid, this.id, reviewId);
      this.currentId = uuid;
    });
  }

  private async write(revision: string | null, action: (string | number)[],
    prepare: (mutation: ProgressMutation) => () => Promise<void>) {
    const key = JSON.stringify([revision, ...action]);
    if (this.retry?.pending && this.retry.key !== key) throw new StaleStudyState();
    const retry = this.retry?.key === key ? this.retry : {
      key, run: prepare({ revision, id: globalThis.crypto.randomUUID() }),
    };
    this.retry = retry;
    retry.pending ??= retry.run();
    try {
      await retry.pending;
      this.retry = undefined;
    } finally {
      retry.pending = undefined;
    }
  }
}
