import { isCardId } from "./card-id";
import type { Format } from "./markdown";

export type SourceRequest =
  | { kind: "file"; path: string; format?: Format }
  | { kind: "folder"; path: string; recursive?: boolean; format?: Format };

export interface Source {
  id: string;
  kind: SourceRequest["kind"];
  path: string;
  recursive: boolean;
  format: Format;
  excluded: string[];
}

export interface Section {
  id: string;
  name: string;
  sources: Source[];
  noteSelections?: Record<string, string[]>;
}
interface KnownCard { question: string; answerHash: number; id: string }
export interface KnownNote { format: Format; cards: KnownCard[] }

export type ReviewGrade = "again" | "hard" | "good" | "easy";
export interface IntervalReview {
  id: string;
  sessionId: string;
  sectionId: string;
  grade: ReviewGrade;
  at: string;
  order: number;
  previousSchedule?: unknown;
}

export interface ReviewSchedule {
  dueAt: string;
  [field: string]: unknown;
}

export interface CardProgress {
  history?: unknown;
  schedule?: unknown;
  reviews?: IntervalReview[];
  suspended?: boolean;
}

export type FreeGrade = "correct" | "incorrect";

interface FreeCheck {
  id: string;
  sectionId: string;
  cardIds: string[];
  grades: Record<string, FreeGrade>;
  startedAt: string;
  retryOf: string | null;
}

export interface FreeSession extends FreeCheck {
  position: number;
  furthestPosition?: number;
}

export interface FreeResult extends FreeCheck {
  finishedAt: string;
  ungradedUnavailable?: number;
}

export interface StudyData {
  sections: Section[];
  knownNotes: Record<string, KnownNote>;
  progress: Record<string, CardProgress>;
  freeResults: FreeResult[];
  freeSession: FreeSession | null;
}

export const emptyStudyData = (): StudyData => ({
  sections: [], knownNotes: {}, progress: {}, freeResults: [], freeSession: null,
});

export const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): value is string => typeof value === "string";
const id = (value: unknown): value is string => text(value) && value.length > 0;
export const isDate = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
const distinct = (values: string[]) => new Set(values).size === values.length;
export const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(id) && distinct(value);

function format(value: unknown): boolean {
  return record(value) && (value.mode === "single" ? value.question === "heading" || value.question === "filename"
    : value.mode === "collection" && Number.isInteger(value.level) && Number(value.level) >= 1 && Number(value.level) <= 6);
}

function sections(value: unknown): value is Section[] {
  return Array.isArray(value) && value.every((section) => record(section) && id(section.id) && id(section.name)
    && Array.isArray(section.sources) && section.sources.every((source) => record(source) && id(source.id)
      && (source.kind === "file" ? id(source.path) : source.kind === "folder" && text(source.path))
      && typeof source.recursive === "boolean" && format(source.format) && stringList(source.excluded))
    && (section.noteSelections === undefined || (record(section.noteSelections)
      && Object.entries(section.noteSelections).every(([path, ids]) => id(path) && stringList(ids) && ids.every(isCardId))))
    && distinct(section.sources.map(({ id }) => id))) && distinct(value.map(({ id }) => id));
}

function knownNotes(value: unknown): value is StudyData["knownNotes"] {
  return record(value) && Object.values(value).every((note) => record(note) && format(note.format)
    && Array.isArray(note.cards) && note.cards.every((card) => record(card) && isCardId(card.id)
      && text(card.question) && Number.isSafeInteger(card.answerHash)));
}

function review(value: unknown): value is IntervalReview {
  return record(value) && id(value.id) && id(value.sessionId) && id(value.sectionId) && isDate(value.at)
    && Number.isSafeInteger(value.order) && Number(value.order) > 0
    && (value.grade === "again" || value.grade === "hard" || value.grade === "good" || value.grade === "easy");
}

function progress(value: unknown): value is StudyData["progress"] {
  return record(value) && Object.entries(value).every(([key, card]) => isCardId(key) && record(card)
    && (card.suspended === undefined || typeof card.suspended === "boolean")
    && (card.reviews === undefined || (Array.isArray(card.reviews) && card.reviews.every(review)
      && distinct(card.reviews.map(({ id }) => id))
      && (!card.reviews.length || (record(card.schedule) && isDate(card.schedule.dueAt))))));
}

function freeCheck(value: unknown): value is FreeCheck {
  return record(value) && id(value.id) && id(value.sectionId) && isDate(value.startedAt)
    && (value.retryOf === null || id(value.retryOf)) && stringList(value.cardIds)
    && value.cardIds.length > 0 && value.cardIds.every(isCardId) && record(value.grades)
    && Object.entries(value.grades).every(([key, grade]) => (value.cardIds as string[]).includes(key)
      && (grade === "correct" || grade === "incorrect"));
}

function freeSession(value: unknown): value is FreeSession {
  return record(value) && Number.isInteger(value.position) && Number(value.position) >= 0
    && freeCheck(value) && Number(value.position) < value.cardIds.length
    && (value.furthestPosition === undefined || (Number.isInteger(value.furthestPosition)
      && Number(value.furthestPosition) >= Number(value.position) && Number(value.furthestPosition) < value.cardIds.length));
}

function freeResult(value: unknown): value is FreeResult {
  if (!record(value) || !isDate(value.finishedAt) || !freeCheck(value)) return false;
  const graded = Object.keys(value.grades).length;
  return graded > 0 && (value.ungradedUnavailable === undefined || (Number.isInteger(value.ungradedUnavailable)
    && Number(value.ungradedUnavailable) >= 0 && Number(value.ungradedUnavailable) <= value.cardIds.length - graded));
}

export function validStudyData(value: unknown): value is StudyData {
  if (!record(value) || !sections(value.sections) || !knownNotes(value.knownNotes) || !progress(value.progress)
    || !Array.isArray(value.freeResults) || !value.freeResults.every(freeResult)
    || !distinct(value.freeResults.map(({ id }) => id))) return false;
  const session = value.freeSession;
  return session === null || (freeSession(session) && !value.freeResults.some(({ id }) => id === session.id)
    && value.sections.some(({ id }) => id === session.sectionId));
}

export function legacyStudyData(value: unknown): { data: StudyData; activeSection: string | null } | null {
  if (!record(value) || "version" in value || !sections(value.sections)
    || !knownNotes(value.knownNotes) || !progress(value.progress)
    || (value.activeSection !== null && !id(value.activeSection))) return null;
  return {
    data: { ...emptyStudyData(), sections: value.sections, knownNotes: value.knownNotes, progress: value.progress },
    activeSection: value.activeSection,
  };
}
