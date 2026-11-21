import type { Card } from "./study-cards";
import type { FreeResult, FreeSession } from "./study-state";

export type CheckCard = Card & { id: string };
export type CheckOrder = "standard" | "random";

export type CheckSelection =
  | { order: CheckOrder; sectionId: string; count: number; start?: string }
  | { sectionId: string; cardIds: readonly string[] }
  | { retryOf: string };

export function isCheckCard(card: Card): card is CheckCard {
  return card.id !== null && card.identity === "valid" && card.status !== "invalid";
}

export function checkRange(cards: readonly CheckCard[], order: CheckOrder, start?: string) {
  const offset = order === "random" || !start ? 0 : cards.findIndex(({ id }) => id === start);
  return { offset, maximum: offset < 0 ? 0 : cards.length - offset };
}

export function sampleCards(cards: readonly CheckCard[], order: CheckOrder, count: number, offset: number) {
  if (order === "standard") return cards.slice(offset, offset + count);
  const shuffled = [...cards];
  for (let index = 0; index < count; index++) {
    const next = index + Math.floor(Math.random() * (shuffled.length - index));
    [shuffled[index], shuffled[next]] = [shuffled[next]!, shuffled[index]!];
  }
  return shuffled.slice(0, count);
}

export function canAdvance(session: FreeSession, available: boolean) {
  return session.position < (session.furthestPosition ?? session.position)
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
