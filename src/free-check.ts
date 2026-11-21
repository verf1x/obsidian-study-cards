import type { Card } from "./study-cards";
import type { FreeResult, FreeSession } from "./study-state";

export type CheckCard = Card & { id: string };

export type CheckSelection =
  | { order: "standard" | "random"; sectionId: string; count: number; start?: string }
  | { retryOf: string };

export function isCheckCard(card: Card): card is CheckCard {
  return card.id !== null && card.identity === "valid" && card.status !== "invalid";
}

export function sampleCards(cards: readonly CheckCard[], order: "standard" | "random", count: number, offset: number) {
  if (order === "standard") return cards.slice(offset, offset + count);
  const shuffled = [...cards];
  for (let index = 0; index < count; index++) {
    const next = index + Math.floor(Math.random() * (shuffled.length - index));
    [shuffled[index], shuffled[next]] = [shuffled[next]!, shuffled[index]!];
  }
  return shuffled.slice(0, count);
}

export function canAdvance(session: FreeSession, available: boolean) {
  return session.position < (session.reached ?? session.position)
    || !available || Boolean(session.grades[session.cardIds[session.position]!]);
}

export function checkScore(check: FreeResult | FreeSession, available: ReadonlySet<string>) {
  const correct = check.cardIds.filter((id) => check.grades[id] === "correct").length;
  const mistakes = check.cardIds.filter((id) => check.grades[id] === "incorrect");
  const graded = correct + mistakes.length;
  const ungraded = check.cardIds.length - graded;
  const unavailable = ("finishedAt" in check ? check.ungradedUnavailable : undefined)
    ?? check.cardIds.filter((id) => !check.grades[id] && !available.has(id)).length;
  return { correct, mistakes, graded, ungraded, unavailable };
}
