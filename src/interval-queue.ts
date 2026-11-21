import type { Card } from "./study-cards";
import { isDate, record } from "./study-state";

export type ReviewCard = Card & { id: string };

export function isReviewCard(card: Card): card is ReviewCard {
  return card.id !== null && card.identity === "valid" && !card.progress?.suspended
    && (card.status === "studied" || card.status === "mastered");
}

export function reviewDue(card: Card) {
  const schedule = card.progress?.schedule;
  return record(schedule) && isDate(schedule.dueAt) ? new Date(schedule.dueAt) : undefined;
}

export function reviewQueue(cards: readonly ReviewCard[], now: Date) {
  let nextDue: Date | undefined;
  const ready = [];
  for (const card of cards) {
    const due = reviewDue(card);
    if (due && due > now) {
      if (!nextDue || due < nextDue) nextDue = due;
      continue;
    }
    const schedule = card.progress?.schedule;
    const priority = !due ? 2 : record(schedule) && schedule.scheduleStatus === "learning" ? 0 : 1;
    ready.push({ card, priority, due: due?.getTime() ?? 0 });
  }
  ready.sort((a, b) => a.priority - b.priority || a.due - b.due);
  return { ready: ready.map(({ card }) => card), nextDue };
}
