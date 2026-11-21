import { sampleCards, type CheckCard } from "../free-check";
export { isCheckCard, type CheckCard } from "../free-check";

export type Grade = "correct" | "wrong";
export type Order = "standard" | "random";

interface Question { id: string; question: string; grade?: Grade }

export class Check {
  readonly questions: Question[];
  readonly revealed = new Set<string>();
  position = 0;
  reached = 0;

  constructor(readonly sectionId: string, readonly sectionName: string, questions: readonly Question[],
    readonly retry = false) {
    this.questions = questions.map(({ id, question }) => ({ id, question }));
  }

  get current() { return this.questions[this.position]!; }

  get correct() { return this.questions.filter(({ grade }) => grade === "correct").length; }
  get mistakes() { return this.questions.filter(({ grade }) => grade === "wrong"); }
  get graded() { return this.correct + this.mistakes.length; }
  get ungraded() { return this.questions.length - this.graded; }

  rate(card: CheckCard, grade: Grade) {
    this.current.question = card.question;
    this.current.grade = grade;
  }

  move(direction: -1 | 1) {
    this.position += direction;
    this.reached = Math.max(this.reached, this.position);
  }
}

export class PrototypeChecks {
  private current?: Check;
  private readonly listeners = new Set<() => void>();
  readonly history: Check[] = [];

  get active() { return this.current; }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start(check: Check) {
    this.current = check;
    this.notify();
  }

  update(check: Check, change: () => void) {
    if (this.current !== check) return;
    change();
    this.notify();
  }

  finish(check: Check) {
    if (this.current !== check) return false;
    this.current = undefined;
    if (check.graded > 0) this.history.unshift(check);
    this.notify();
    return true;
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }
}

export function sample(cards: readonly CheckCard[], order: Order, count: number, start?: string) {
  return sampleCards(cards, order, count, Math.max(0, cards.findIndex(({ id }) => id === start)));
}
