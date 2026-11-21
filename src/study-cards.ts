import type { CardProgress, FreeGrade, FreeSession, IntervalReview, KnownNote, ReviewSchedule, Section, Source, SourceRequest, StudyData } from "./study-state";
import { StaleStudyState, StudyStorage, type ImportPreview, type StudyMutation } from "./study-storage";
import { MarkdownNote, sameFormat, single, type Format, type MarkdownCard, type Status } from "./markdown";
import { canAdvance, checkRange, checkScore, isCheckCard, sampleCards, type CheckSelection } from "./free-check";
import { isReviewCard, reviewDue, reviewQueue } from "./interval-queue";

export interface StudyVault {
  markdownFiles(): string[];
  folderExists(path: string): boolean;
  read(path: string): Promise<string>;
  process(path: string, edit: (source: string) => string): Promise<void>;
  hasUnsavedChanges(path: string, saved: string): boolean;
  create(path: string, source: string): Promise<void>;
  trash(path: string, validate: (source: string) => void): Promise<void>;
}

export type { CardProgress, Source, SourceRequest } from "./study-state";

export type ProgressMutation = Pick<StudyMutation, "id" | "revision">;
const unreadableNote = "Заметка недоступна для чтения";

interface IndexedNote {
  note: MarkdownNote;
  format: Format;
  cards: Card[];
  sections: string[];
  error?: string;
}

export interface Card extends MarkdownCard {
  path: string;
  index: number;
  line: number;
  identity: "valid" | "missing" | "invalid" | "duplicate";
  progress?: CardProgress;
}

export interface PreviewRow {
  path: string;
  source: number;
  checked: boolean;
  format: Format;
  formats: Format[];
  needsFormat: boolean;
  cards: (MarkdownCard & { firstLine: number; lastLine: number })[];
  dirty: boolean;
  error?: string;
}

interface PlannedRow extends PreviewRow { text: string; excluded: boolean }
export type Confirmation = { confirmed: true } | { confirmed: false; paths: readonly string[] };

const hasPath = (path: string, parent: string) => parent === "" || path === parent || path.startsWith(parent + "/");
export const remapPath = (path: string, oldPath: string, newPath: string) => hasPath(path, oldPath)
  ? newPath + path.slice(oldPath.length) : path;
const directory = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

function includesPath(source: SourceRequest, path: string) {
  return source.kind === "file" ? source.path === path
    : source.recursive ? hasPath(directory(path), source.path) : directory(path) === source.path;
}

function answerHash(answer: string) {
  let hash = 0;
  for (let index = 0; index < answer.length; index++) hash = Math.imul(hash, 31) + answer.charCodeAt(index) | 0;
  return hash;
}

function previousIds(cards: MarkdownCard[], known: KnownNote | undefined, format: Format) {
  const previous = known && (sameFormat(known.format, format) || (known.format.mode === "single" && format.mode === "single"))
    ? known.cards : [];
  const available = previous.map((record, index) => ({ record, index }));
  const anchors = new Map<number, number>();
  const ids = new Map<MarkdownCard, string>();
  const claim = (card: MarkdownCard, index: number, candidate: number) => {
    if (candidate < 0) return;
    const [old] = available.splice(candidate, 1);
    anchors.set(index, old!.index);
    if (!card.id) ids.set(card, old!.record.id);
  };
  cards.forEach((card, index) => {
    if (!card.id) return;
    const exact = available.findIndex(({ record }) => record.id === card.id && record.question === card.question);
    claim(card, index, exact >= 0 ? exact : available.findIndex(({ record }) => record.id === card.id));
  });
  cards.forEach((card, index) => {
    if (!card.id) claim(card, index, available.findIndex(({ record }) => record.question === card.question));
  });
  cards.forEach((card, index) => {
    if (card.id || ids.has(card) || !card.answer) return;
    const hash = answerHash(card.answer);
    const first = available.findIndex(({ record }) => record.answerHash === hash);
    if (first >= 0 && !available.some(({ record }, candidate) => candidate > first && record.answerHash === hash)) {
      claim(card, index, first);
    }
  });

  // A rewritten question can occupy the same gap between surviving UUIDs.
  const nextAnchor: number[] = [];
  let upper = previous.length;
  for (let index = cards.length - 1; index >= 0; index--) {
    nextAnchor[index] = upper;
    upper = anchors.get(index) ?? upper;
  }
  let lower = -1;
  cards.forEach((card, index) => {
    if (!card.id && !ids.has(card)) {
      claim(card, index, available.findIndex((old) => old.index > lower && old.index < nextAnchor[index]!));
    }
    lower = anchors.get(index) ?? lower;
  });
  const unmatched = cards.map((card, index) => ({ card, index })).filter(({ card }) => !card.id && !ids.has(card));
  if (available.length === 1 && unmatched.length === 1) {
    const { card, index } = unmatched[0]!;
    claim(card, index, 0);
  }
  return ids;
}

class ChangedNote extends Error {
  constructor(readonly path: string) {
    super("Заметка изменилась или ещё сохраняется: " + path);
  }
}

export class StudyCards {
  private data: StudyData;
  private index = new Map<string, IndexedNote>();
  private catalog: { data: StudyData; index: Map<string, IndexedNote>; revision: string | null };
  private readonly listeners = new Set<() => void>();
  private queue = Promise.resolve<unknown>(undefined);
  private catalogChangeCount = 0;
  private saving = false;

  constructor(
    private readonly vault: StudyVault,
    private readonly storage: StudyStorage,
    private readonly newId: () => string,
  ) {
    const { data, revision } = storage.state;
    this.data = data;
    this.catalog = { data, index: this.index, revision };
  }

  get sections(): readonly Section[] { return this.catalog.data.sections; }
  get progressRevision() { return this.catalog.revision; }
  get activeSection() {
    const saved = this.storage.activeSection;
    return this.sections.find(({ id }) => id === saved)?.id ?? this.sections[0]?.id ?? null;
  }

  get persistence() {
    return { token: this.storage.token, problem: this.storage.problem, saving: this.saving,
      hasBeforeImport: this.storage.hasBeforeImport };
  }

  get progress() {
    const { revision, data: { progress, freeSession, freeResults } } = this.catalog;
    return structuredClone({ revision, progress, freeSession, freeResults });
  }

  get freeChecks() {
    const { revision, data: { freeSession, freeResults } } = this.catalog;
    return structuredClone({ revision, session: freeSession, results: freeResults });
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  private enqueue<T>(action: () => Promise<T>) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async adoptStorage() {
    if (this.storage.revision === this.catalog.revision) return;
    const state = this.storage.state;
    this.data = state.data;
    this.index = new Map();
    await this.scanIndex(false);
    this.catalog = { data: this.data, index: this.index, revision: state.revision };
  }

  private storageAction<T>(action: () => Promise<T>) {
    return this.enqueue(async () => {
      this.saving = true;
      this.notify();
      try {
        return await action();
      } finally {
        this.saving = false;
        await this.adoptStorage();
        this.notify();
      }
    });
  }

  refreshStorage() {
    return this.enqueue(async () => {
      const token = this.storage.token;
      await this.storage.refresh();
      await this.adoptStorage();
      if (this.storage.token !== token) this.notify();
    });
  }

  exportStudyData() { return this.storageAction(() => this.storage.export()); }
  exportBeforeImport() { return this.storage.exportBeforeImport(); }
  previewImport(raw: string) { return this.storageAction(() => this.storage.previewImport(raw)); }
  importStudyData(preview: ImportPreview) { return this.storageAction(() => this.storage.import(preview)); }
  chooseStudyVersion(token: number, id: string) { return this.storageAction(() => this.storage.choose(token, id)); }
  restoreStudyData(token: number, useBackup: boolean) { return this.storageAction(() => this.storage.restore(token, useBackup)); }

  private run<T>(description: string, action: () => Promise<T>, options?: { background: boolean }): Promise<T>;
  private run(description: string, action: () => Promise<void>, options: { mutation: ProgressMutation }): Promise<void>;
  private run<T>(description: string, action: () => Promise<T>, options: { background?: boolean; mutation?: ProgressMutation } = {}) {
    const mutation = options.mutation;
    return this.enqueue(async () => {
      const token = this.storage.token;
      const changes = this.catalogChangeCount;
      let published = false;
      try {
        await this.storage.refresh();
        await this.adoptStorage();
        const base = this.catalog;
        if (mutation && this.storage.wasCommitted(mutation.id)) return;
        if (mutation && mutation.revision !== base.revision) throw new StaleStudyState();
        if (!options.background) this.storage.assertWritable();
        this.data = structuredClone(base.data);
        this.index = new Map(base.index);
        const result = await action();
        if (mutation || JSON.stringify(this.data) !== JSON.stringify(base.data)) {
          if (!options.background) {
            this.saving = true;
            this.notify();
          }
          await this.storage.commit({ id: mutation?.id ?? this.newId(), revision: base.revision, action: description }, () => this.data);
          this.data = this.storage.state.data;
          published = true;
        }
        this.catalog = { data: this.data, index: this.index, revision: this.storage.revision };
        return result;
      } finally {
        const wasSaving = this.saving;
        this.saving = false;
        await this.adoptStorage();
        this.data = this.catalog.data;
        this.index = this.catalog.index;
        if (wasSaving || published || changes !== this.catalogChangeCount || token !== this.storage.token) this.notify();
      }
    });
  }

  private section(id: string, data = this.data) {
    const section = data.sections.find((item) => item.id === id);
    if (!section) throw new Error("Учебный раздел не найден");
    return section;
  }

  async addSection(name: string) {
    const id = this.newId();
    await this.run("Добавление учебного раздела", async () => {
      const title = name.trim();
      if (!title) throw new Error("Введите название учебного раздела");
      this.data.sections.push({ id, name: title, sources: [] });
    });
    await this.openSection(id);
    return id;
  }

  openSection(id: string) {
    return this.enqueue(async () => {
      this.section(id, this.catalog.data);
      await this.storage.openSection(id);
      this.notify();
    });
  }

  removeSource(sectionId: string, sourceId: string) {
    return this.run("Отключение источника", async () => {
      const section = this.section(sectionId);
      const removed = section.sources.find(({ id }) => id === sourceId);
      section.sources = section.sources.filter(({ id }) => id !== sourceId);
      if (removed) {
        for (const path of [...this.index.keys()]) {
          if (includesPath(removed, path)) await this.reconcile(path);
        }
      }
    });
  }

  private memberships(path: string, note: MarkdownNote, data = this.data) {
    return data.sections.flatMap((section) => section.sources.flatMap((source) =>
      includesPath(source, path) && (source.kind === "file" || (note.marked && !source.excluded.includes(path)))
        ? [{ section: section.id, source }] : []));
  }

  private formats(note: MarkdownNote, defaults: Format[], data = this.data) {
    const known = data.knownNotes[note.path];
    if (known) return [note.format(known.format)];
    const formats: Format[] = [];
    for (const fallback of defaults) {
      const format = note.format(fallback);
      if (!formats.some((other) => sameFormat(other, format))) formats.push(format);
    }
    return formats;
  }

  private async read(path: string) {
    try {
      return new MarkdownNote(path, await this.vault.read(path));
    } catch (error) {
      if (this.vault.markdownFiles().includes(path)) throw error;
      return undefined;
    }
  }

  private async write(note: MarkdownNote, edit: (current: MarkdownNote) => string) {
    let saved = note.source;
    const validate = (current: string) => {
      if (current !== note.source || this.vault.hasUnsavedChanges(note.path, current)) throw new ChangedNote(note.path);
    };
    validate(saved);
    await this.vault.process(note.path, (current) => {
      validate(current);
      saved = edit(note);
      return saved;
    });
    return new MarkdownNote(note.path, saved);
  }

  private assign(note: MarkdownNote, format: Format, known: KnownNote | undefined) {
    const cards = note.cards(format);
    const missing = previousIds(cards, known, format);
    return new Map(cards.flatMap((card, index) => !card.id && !card.invalidId && !missing.has(card)
      ? [[index, this.newId()]] : []));
  }

  private indexNote(note: MarkdownNote, format: Format, sections: string[], error?: string, updateKnown = true) {
    const path = note.path;
    const known = this.data.knownNotes[path];
    const cards = error ? [] : note.cards(format);
    const missing = previousIds(cards, known, format);
    if (updateKnown && !error && !this.vault.hasUnsavedChanges(path, note.source)) {
      const records = cards.flatMap((card) => {
        const id = card.id ?? missing.get(card);
        return id ? [{ question: card.question, answerHash: answerHash(card.answer), id }] : [];
      });
      this.data.knownNotes[path] = { format, cards: records };
    }
    const indexed = this.index.get(path);
    if (indexed?.note.source === note.source && sameFormat(indexed.format, format) && indexed.error === error
      && sections.length === indexed.sections.length && sections.every((section) => indexed.sections.includes(section))) return;
    this.index.set(path, {
      note, format, sections, error,
      cards: cards.map((card, index) => ({
        ...card, path, index,
        line: note.lineAt(card.from),
        identity: card.id ? "valid" : card.invalidId ? "invalid" : "missing",
      })),
    });
    this.catalogChangeCount++;
  }

  private removeFromIndex(path: string) {
    if (this.index.delete(path)) this.catalogChangeCount++;
  }

  private async reconcile(path: string, autoAssign = true, saved?: MarkdownNote, updateKnown = true) {
    if (this.storage.problem) autoAssign = updateKnown = false;
    if (!this.data.sections.some(({ sources }) => sources.some((source) => includesPath(source, path)))) {
      this.removeFromIndex(path);
      return;
    }
    let note: MarkdownNote | undefined;
    try {
      note = saved ?? await this.read(path);
    } catch {
      const indexed = this.index.get(path);
      if (indexed && indexed.error !== unreadableNote) {
        this.index.set(path, { ...indexed, error: unreadableNote });
        this.catalogChangeCount++;
      }
      return;
    }
    const memberships = note ? this.memberships(path, note) : [];
    if (!note || !memberships.length) {
      this.removeFromIndex(path);
      return;
    }
    const sections = [...new Set(memberships.map(({ section }) => section))];
    const formats = this.formats(note, memberships.map(({ source }) => source.format));
    const format = formats[0]!;
    if (note.error || formats.length > 1) {
      this.indexNote(note, format, sections, note.error ?? "Выберите формат в предпросмотре подключения");
      return;
    }
    const known = this.data.knownNotes[path];
    if (autoAssign && !this.vault.hasUnsavedChanges(path, note.source)) {
      const assign = this.assign(note, format, known);
      const planned = note.enroll(format, assign);
      if (planned !== note.source) {
        try {
          note = await this.write(note, () => planned);
        } catch (error) {
          if (!(error instanceof ChangedNote)) throw error;
          await this.reconcile(path, false);
          return;
        }
      }
    }
    this.indexNote(note, format, sections, undefined, updateKnown);
  }

  private async scanIndex(write: boolean) {
    const paths = new Set(this.vault.markdownFiles());
    for (const path of this.index.keys()) if (!paths.has(path)) this.removeFromIndex(path);
    for (const path of paths) await this.reconcile(path, write, undefined, write);
  }

  scan() {
    return this.run("Обновление каталога", () => this.scanIndex(true), { background: true });
  }

  update(path: string) {
    return this.run("Обновление заметки", () => this.reconcile(path), { background: true });
  }

  recheckIntervalSource(path: string) {
    return this.recheckIntervalSources([path]);
  }

  retryUnreadableIntervalSources(sectionId: string) {
    const paths = [...this.catalog.index].flatMap(([path, { error, sections }]) =>
      error === unreadableNote && sections.includes(sectionId) ? [path] : []);
    if (paths.length) return this.recheckIntervalSources(paths);
  }

  private recheckIntervalSources(paths: string[]) {
    return this.run("Проверка источников интервального повторения", async () => {
      for (const path of paths) await this.reconcile(path, false, undefined, false);
    }, { background: true });
  }

  refreshSources() {
    return this.enqueue(async () => { this.notify(); });
  }

  delete(path: string) {
    return this.run("Удаление заметки", async () => {
      for (const key of this.index.keys()) if (hasPath(key, path)) this.removeFromIndex(key);
      if (this.data.sections.some(({ sources }) => sources.some((source) => hasPath(source.path, path)))) this.catalogChangeCount++;
    }, { background: true });
  }

  rename(oldPath: string, newPath: string) {
    return this.run("Перемещение источника", async () => {
      if (this.storage.problem) {
        this.catalogChangeCount++;
        await this.scanIndex(false);
        return;
      }
      for (const section of this.data.sections) {
        for (const source of section.sources) {
          source.path = remapPath(source.path, oldPath, newPath);
          source.excluded = source.excluded.map((path) => remapPath(path, oldPath, newPath));
        }
      }
      for (const path of Object.keys(this.data.knownNotes)) {
        if (!hasPath(path, oldPath)) continue;
        const moved = remapPath(path, oldPath, newPath);
        if (/\.md$/i.test(moved)) this.data.knownNotes[moved] = this.data.knownNotes[path]!;
        delete this.data.knownNotes[path];
      }
      for (const path of this.index.keys()) if (hasPath(path, oldPath)) this.removeFromIndex(path);
      for (const path of this.vault.markdownFiles()) {
        if (hasPath(path, newPath)) await this.reconcile(path);
      }
    }, { background: true });
  }

  private allCards(data = this.data, index = this.index) {
    const counts = new Map<string, number>();
    const cards: Card[] = [];
    for (const entry of index.values()) {
      for (const card of entry.cards) {
        if (card.id) counts.set(card.id, (counts.get(card.id) ?? 0) + 1);
        if (!entry.error) cards.push(card);
      }
    }
    return cards.map((card): Card => card.id ? {
      ...card,
      identity: counts.get(card.id)! > 1 ? "duplicate" : "valid",
      progress: counts.get(card.id) === 1 ? data.progress[card.id] : undefined,
    } : card);
  }

  cards(sectionId: string, order?: "source") {
    return this.sectionCards(sectionId, order, this.catalog.data, this.catalog.index);
  }

  intervalCards(sectionId: string | null, order?: "source") {
    if (sectionId !== null && !this.sections.some(({ id }) => id === sectionId)) return [];
    const { data, index } = this.catalog;
    const cards = sectionId === null ? this.allCards(data, index) : this.cards(sectionId, order);
    const files = new Set(this.vault.markdownFiles());
    return cards.filter(isReviewCard).filter(({ path }) => files.has(path));
  }

  private sectionCards(sectionId: string, order?: "source", data = this.data, index = this.index) {
    const cards = this.allCards(data, index).filter((card) => index.get(card.path)?.sections.includes(sectionId));
    if (order !== "source") return cards;
    const sources = this.section(sectionId, data).sources;
    const positions = new Map<string, number>();
    for (const { path } of cards) {
      if (positions.has(path)) continue;
      const membership = this.memberships(path, index.get(path)!.note, data).find(({ section }) => section === sectionId);
      positions.set(path, membership ? sources.indexOf(membership.source) : sources.length);
    }
    return cards.sort((left, right) => positions.get(left.path)! - positions.get(right.path)!
      || left.path.localeCompare(right.path) || left.index - right.index);
  }

  missingSources(sectionId: string) {
    const files = new Set(this.vault.markdownFiles());
    return this.section(sectionId, this.catalog.data).sources.filter((source) =>
      source.kind === "file" ? !files.has(source.path) : !this.vault.folderExists(source.path));
  }

  errors(sectionId: string) {
    return [...this.catalog.index.entries()].flatMap(([path, entry]) =>
      entry.error && entry.sections.includes(sectionId) ? [{ path, message: entry.error }] : []);
  }

  duplicates(id: string) {
    return this.allCards(this.catalog.data, this.catalog.index).filter((card) => card.id === id && card.identity === "duplicate");
  }

  canTrash(card: Card) {
    return this.catalog.index.get(card.path)?.format.mode === "single";
  }

  private currentCard(selected: Card) {
    const entry = this.index.get(selected.path);
    const card = entry?.cards[selected.index];
    if (!entry || !card || card.id !== selected.id || card.question !== selected.question
      || card.answer !== selected.answer || card.status !== selected.status) throw new ChangedNote(selected.path);
    return { entry, card };
  }

  setStatus(selected: Card, status: Status) {
    return this.run("Изменение статуса освоения", async () => {
      const { entry } = this.currentCard(selected);
      const saved = await this.write(entry.note, (note) => note.setStatus(entry.format, selected.index, status));
      await this.reconcile(selected.path, false, saved);
    });
  }

  private async verifyCard(selected: Card) {
    const { entry } = this.currentCard(selected);
    const current = this.allCards().find((card) => card.path === selected.path && card.index === selected.index);
    if (!current?.id || current.identity !== "valid" || current.status === "invalid") {
      throw new Error("Исправьте UUID и статус освоения карточки");
    }
    const note = await this.read(current.path);
    if (!note || note.source !== entry.note.source || this.vault.hasUnsavedChanges(current.path, note.source)) {
      throw new ChangedNote(current.path);
    }
    return current.id;
  }

  saveProgress(selected: Card, progress: CardProgress) {
    return this.run("Изменение прогресса карточки", async () => {
      const id = await this.verifyCard(selected);
      if (JSON.stringify(selected.progress) !== JSON.stringify(this.data.progress[id])) throw new StaleStudyState();
      this.data.progress[id] = { ...this.data.progress[id], ...progress };
    });
  }

  recordReview(mutation: ProgressMutation, selected: Card,
    review: Omit<IntervalReview, "id" | "previousSchedule" | "order">, schedule: ReviewSchedule) {
    return this.run("Интервальная оценка", async () => {
      const id = await this.verifyCard(selected);
      const prior = this.data.progress[id];
      const current = { ...selected, progress: prior };
      const due = reviewDue(current);
      if (!this.index.get(selected.path)?.sections.includes(review.sectionId) || !isReviewCard(current)
        || (due && due.getTime() > Date.parse(review.at))) {
        throw new StaleStudyState();
      }
      const order = (this.lastReview(review.sessionId, this.data)?.review.order ?? 0) + 1;
      this.data.progress[id] = {
        ...prior, schedule,
        reviews: [...(prior?.reviews ?? []), { ...review, id: mutation.id, order, previousSchedule: prior?.schedule }],
      };
    }, { mutation });
  }

  private lastReview(sessionId: string, data: StudyData) {
    let last: { uuid: string; review: IntervalReview } | undefined;
    for (const [uuid, { reviews }] of Object.entries(data.progress)) {
      for (const review of reviews ?? []) {
        if (review.sessionId === sessionId && (!last || review.order > last.review.order)) last = { uuid, review };
      }
    }
    return last;
  }

  private reviewToUndo(sessionId: string, data: StudyData) {
    const last = this.lastReview(sessionId, data);
    if (!last) return;
    const progress = data.progress[last.uuid]!;
    const reviews = progress.reviews;
    if (reviews?.[reviews.length - 1]?.id === last.review.id) return { ...last, progress, reviews };
  }

  latestIntervalReview(sessionId: string) {
    const last = this.reviewToUndo(sessionId, this.catalog.data);
    if (last) return { uuid: last.uuid, reviewId: last.review.id, revision: this.progressRevision };
  }

  intervalStatistics(sectionId: string | null, now: Date) {
    const { ready, nextDue } = reviewQueue(this.intervalCards(sectionId), now);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    const reviewed = new Set<string>();
    let reviews = 0;
    for (const [uuid, progress] of Object.entries(this.catalog.data.progress)) {
      for (const review of progress.reviews ?? []) {
        const at = Date.parse(review.at);
        if ((sectionId === null || sectionId === review.sectionId) && at >= today && at < tomorrow) {
          reviewed.add(uuid);
          reviews++;
        }
      }
    }
    return { available: ready.length, cards: reviewed.size, reviews, nextDue, dayEndsAt: tomorrow };
  }

  undoReview(mutation: ProgressMutation, uuid: string, sessionId: string, reviewId: string) {
    return this.run("Отмена интервальной оценки", async () => {
      const last = this.reviewToUndo(sessionId, this.data);
      if (last?.uuid !== uuid || last.review.id !== reviewId) throw new StaleStudyState();
      this.data.progress[uuid] = {
        ...last.progress, schedule: last.review.previousSchedule, reviews: last.reviews.slice(0, -1),
      };
    }, { mutation });
  }

  setSuspended(mutation: ProgressMutation, selected: Card, suspended: boolean) {
    return this.run(suspended ? "Приостановка повторений" : "Возобновление повторений", async () => {
      const id = await this.verifyCard(selected);
      this.data.progress[id] = { ...this.data.progress[id], suspended };
    }, { mutation });
  }

  freeCheckQuestions() {
    const session = this.catalog.data.freeSession;
    if (!session) return [];
    const cards = new Map(this.cards(session.sectionId).filter(isCheckCard)
      .map((card) => [card.id, card]));
    return session.cardIds.map((id) => ({ id, card: cards.get(id) ?? null, grade: session.grades[id] ?? null }));
  }

  startFreeCheck(mutation: ProgressMutation, previousId: string | null, selection: CheckSelection, startedAt: string) {
    return this.run("Начало свободной проверки", async () => {
      if ((this.data.freeSession?.id ?? null) !== previousId) throw new StaleStudyState();
      const result = "retryOf" in selection ? this.data.freeResults.find(({ id }) => id === selection.retryOf) : undefined;
      if ("retryOf" in selection && !result) throw new StaleStudyState();
      const sectionId = "sectionId" in selection ? selection.sectionId : result!.sectionId;
      const cards = this.sectionCards(sectionId, "source").filter(isCheckCard);
      let cardIds: string[];
      if ("order" in selection) {
        const { offset, maximum } = checkRange(cards, selection.order, selection.start);
        if (!Number.isInteger(selection.count) || selection.count < 1 || selection.count > maximum) {
          throw new Error("Изменилось количество доступных вопросов. Проверьте настройки проверки.");
        }
        cardIds = sampleCards(cards, selection.order, selection.count, offset).map(({ id }) => id);
      } else {
        const available = new Set(cards.map(({ id }) => id));
        cardIds = checkScore(result!, available).mistakes;
        if (!cardIds.some((id) => available.has(id))) throw new Error("Все вопросы с ошибками недоступны.");
      }
      this.data.freeSession = {
        id: mutation.id, sectionId, startedAt, retryOf: result?.id ?? null, cardIds, position: 0, furthestPosition: 0, grades: {},
      };
    }, { mutation });
  }

  private freeSession(sessionId: string) {
    const session = this.data.freeSession;
    if (!session || session.id !== sessionId) throw new StaleStudyState();
    return session;
  }

  moveFreeCheck(mutation: ProgressMutation, sessionId: string, direction: -1 | 1) {
    return this.run("Переход к вопросу свободной проверки", async () => {
      const session = this.freeSession(sessionId);
      const position = session.position + direction;
      if (position < 0 || position >= session.cardIds.length) throw new StaleStudyState();
      if (direction === 1) {
        const id = session.cardIds[session.position];
        const available = this.sectionCards(session.sectionId).some((card) => card.id === id && isCheckCard(card));
        if (!canAdvance(session, available)) throw new Error("Оцените текущий ответ, чтобы перейти дальше.");
      }
      session.furthestPosition = Math.max(session.furthestPosition ?? session.position, position);
      session.position = position;
    }, { mutation });
  }

  gradeFreeCheck(mutation: ProgressMutation, sessionId: string, selected: Card, grade: FreeGrade) {
    return this.run("Оценка ответа свободной проверки", async () => {
      const session = this.freeSession(sessionId);
      if (selected.id !== session.cardIds[session.position]
        || !this.index.get(selected.path)?.sections.includes(session.sectionId)) throw new StaleStudyState();
      const id = await this.verifyCard(selected);
      session.grades[id] = grade;
    }, { mutation });
  }

  saveFreeCheck(mutation: ProgressMutation, session: FreeSession) {
    return this.run("Сохранение свободной проверки", async () => {
      const previous = this.data.freeSession;
      if (previous && (previous.id !== session.id || previous.sectionId !== session.sectionId
        || previous.startedAt !== session.startedAt || previous.retryOf !== session.retryOf
        || JSON.stringify(previous.cardIds) !== JSON.stringify(session.cardIds))) throw new StaleStudyState();
      const cards = this.allCards().filter((card) => this.index.get(card.path)?.sections.includes(session.sectionId));
      for (const [id, grade] of Object.entries(session.grades)) {
        if (previous?.grades[id] === grade) continue;
        const card = cards.find((item) => item.id === id);
        if (!card) throw new Error("Вопрос пока недоступен.");
        await this.verifyCard(card);
      }
      const furthestPosition = Math.max(session.furthestPosition ?? session.position, previous?.furthestPosition ?? previous?.position ?? 0);
      this.data.freeSession = structuredClone({ ...session, furthestPosition, grades: { ...previous?.grades, ...session.grades } });
    }, { mutation });
  }

  finishFreeCheck(mutation: ProgressMutation, sessionId: string, finishedAt: string) {
    return this.run("Завершение свободной проверки", async () => {
      const session = this.freeSession(sessionId);
      const { position: _position, furthestPosition: _furthest, ...result } = session;
      const available = new Set(this.sectionCards(session.sectionId).filter(isCheckCard).map(({ id }) => id));
      const { graded, unavailable } = checkScore(session, available);
      if (graded) this.data.freeResults.push({ ...result, finishedAt, ungradedUnavailable: unavailable });
      this.data.freeSession = null;
    }, { mutation });
  }

  discardFreeCheck(mutation: ProgressMutation, sessionId: string) {
    return this.run("Отказ от свободной проверки", async () => {
      this.freeSession(sessionId);
      this.data.freeSession = null;
    }, { mutation });
  }

  repairId(selected: Card) {
    return this.run("Исправление UUID", async () => {
      const { entry, card } = this.currentCard(selected);
      if (card.id) throw new Error("У карточки уже есть UUID");
      const saved = await this.write(entry.note, (note) => note.setId(entry.format, card.index, this.newId()));
      await this.reconcile(card.path, false, saved);
    });
  }

  resolveDuplicate(keep: Card, change: Card, action: "new-id" | "trash") {
    return this.run("Разрешение конфликта UUID", async () => {
      const winner = this.currentCard(keep);
      const { entry, card } = this.currentCard(change);
      if (!winner.card.id || winner.card.id !== card.id || (keep.path === change.path && keep.index === change.index)) {
        throw new Error("Карточки с одинаковым UUID больше не найдены");
      }
      const raw = await this.read(keep.path);
      if (!raw || raw.source !== winner.entry.note.source || this.vault.hasUnsavedChanges(keep.path, raw.source)) {
        throw new ChangedNote(keep.path);
      }
      if (action === "trash") {
        if (entry.format.mode !== "single" || keep.path === change.path) {
          throw new Error("В коллекции можно заменить UUID выбранного вопроса");
        }
        await this.vault.trash(card.path, (text) => {
          if (text !== entry.note.source || this.vault.hasUnsavedChanges(card.path, text)) throw new ChangedNote(card.path);
        });
        this.removeFromIndex(card.path);
        return;
      }
      const saved = await this.write(entry.note, (note) => note.setId(entry.format, card.index, this.newId()));
      await this.reconcile(card.path, false, saved);
    });
  }

  createCard(sectionId: string, filename: string, folder: string, format: Format, template: boolean) {
    return this.run("Создание карточки", async () => {
      const section = this.section(sectionId);
      const name = filename.trim().replace(/\.md$/i, "");
      if (!name || name === "." || name === ".." || /[\\/:*?"<>|\r\n]/.test(name)) {
        throw new Error("Введите допустимое имя Markdown-файла");
      }
      const path = (folder ? folder + "/" : "") + name + ".md";
      const body = template ? "#".repeat(format.mode === "single" ? 1 : format.level) + " Вопрос\n\nОтвет\n" : "";
      const note = new MarkdownNote(path, body);
      const source = note.enroll(format, this.assign(note, format, undefined));
      await this.vault.create(path, source);
      section.sources.push({ id: this.newId(), kind: "file", path, recursive: false, format, excluded: [] });
      await this.reconcile(path, false, new MarkdownNote(path, source));
      return path;
    });
  }

  preview(sectionId: string, requests: SourceRequest[], replaceSourceId?: string) {
    this.section(sectionId, this.catalog.data);
    return new EnrollmentPreview(requests.map((request) => ({ ...request })),
      (sources, getChoice, previous, affected) => this.plan(sectionId, sources, getChoice, this.catalog.data, previous, affected),
      (sources, rows, getChoice) => this.run("Подключение источников", () => this.enroll(sectionId, sources, rows, getChoice, replaceSourceId)));
  }

  private async plan(sectionId: string, requests: SourceRequest[], getChoice: PreviewChoice,
    data: StudyData, previous: PlannedRow[] = [], affected?: ReadonlySet<string>) {
    const paths = this.vault.markdownFiles().sort((a, b) => a.localeCompare(b));
    const rows: PlannedRow[] = [];
    const changedPaths = affected ? [...affected] : [];
    const cached = new Map<string, PlannedRow[]>();
    for (const row of previous) {
      const found = cached.get(row.path);
      if (found) found.push(row);
      else cached.set(row.path, [row]);
    }
    for (const path of paths) {
      const sources = requests.flatMap((request, index) => includesPath(request, path) ? [index] : []);
      if (!sources.length) continue;
      const unchanged = cached.get(path);
      if (affected && !changedPaths.some((changed) => hasPath(path, changed)) && unchanged && unchanged.length === sources.length
        && unchanged.every(({ source }) => sources.includes(source))) {
        rows.push(...unchanged);
        continue;
      }
      const note = await this.read(path);
      if (!note) continue;
      const items = sources.map((source) => {
        const request = requests[source]!;
        const existing = request.kind === "folder" && this.section(sectionId, data).sources.some((item) =>
          item.kind === "folder" && item.path === request.path && item.excluded.includes(path));
        const choice = getChoice(source, path);
        return {
          source, choice, checked: choice.checked ?? (request.kind === "file" || (note.marked && !existing)),
          excluded: choice.checked === false || (choice.checked === undefined && existing),
        };
      });
      const defaults = [
        ...this.memberships(path, note, data).map(({ source }) => source.format),
        ...items.filter(({ checked }) => checked).map(({ source }) => requests[source]!.format ?? single),
      ];
      const chosen = items.find(({ checked, choice }) => checked && choice.format)?.choice.format;
      const dirty = this.vault.hasUnsavedChanges(path, note.source);
      for (const { source, checked, choice, excluded } of items) {
        const formats = this.formats(note, defaults.length ? defaults : [requests[source]!.format ?? single], data);
        const choiceFormat = chosen ?? choice.format;
        const selected = formats.find((item) => choiceFormat && sameFormat(item, choiceFormat));
        const cards = note.error ? [] : note.cards(selected ?? formats[0]!).map((card) => ({
          ...card,
          firstLine: note.lineAt(card.from),
          lastLine: note.lineAt(Math.max(card.from, card.to - 1)),
        }));
        rows.push({
          path, source, checked, format: selected ?? formats[0]!, formats, needsFormat: formats.length > 1 && !selected,
          cards, text: note.source, error: note.error, dirty, excluded,
        });
      }
    }
    return rows;
  }

  private async enroll(sectionId: string, requests: SourceRequest[], rows: PlannedRow[], getChoice: PreviewChoice,
    replaceSourceId?: string) {
    const section = this.section(sectionId);
    const replaced = section.sources.find(({ id }) => id === replaceSourceId);
    if (replaceSourceId && (!replaced || requests.length !== 1 || requests[0]?.kind !== replaced.kind)) {
      throw new StaleStudyState();
    }
    const missingFolders = () => requests.flatMap(({ kind, path }) =>
      kind === "folder" && !this.vault.folderExists(path) ? [path] : []);
    const latest = await this.plan(sectionId, requests, getChoice, this.data);
    const stale = new Set(missingFolders());
    if (replaced && requests[0]?.kind === "file" && !latest.some(({ checked }) => checked)) stale.add(requests[0].path);
    const key = ({ path, source }: PlannedRow) => JSON.stringify([source, path]);
    const baseline = new Map(rows.map((row) => [key(row), row]));
    for (const row of latest) {
      const old = baseline.get(key(row));
      if (old && (old.checked !== row.checked || old.excluded !== row.excluded)) stale.add(row.path);
      if (row.checked && (!old || old.text !== row.text || !sameFormat(old.format, row.format)
        || row.dirty || row.error || row.needsFormat)) stale.add(row.path);
      baseline.delete(key(row));
    }
    for (const row of baseline.values()) if (row.checked || row.excluded) stale.add(row.path);
    if (stale.size) return { confirmed: false, paths: [...stale] } as const;

    const eligible = new Map(latest.filter(({ checked }) => checked).map((row) => [row.path, row]));
    for (const row of eligible.values()) {
      const note = new MarkdownNote(row.path, row.text);
      try {
        await this.write(note, (current) => current.enroll(row.format,
          this.assign(current, row.format, this.data.knownNotes[row.path])));
      } catch (error) {
        if (!(error instanceof ChangedNote) && this.vault.markdownFiles().includes(row.path)) throw error;
        stale.add(row.path);
      }
    }
    for (const path of missingFolders()) stale.add(path);
    if (stale.size) return { confirmed: false, paths: [...stale] } as const;

    requests.forEach((request, index) => {
      const matches = latest.filter(({ source }) => source === index);
      if (request.kind === "file" && !matches.some(({ checked }) => checked)) return;
      const previous = section.sources.find(({ kind, path }) => request.kind === kind && request.path === path);
      const source: Source = {
        id: previous?.id ?? replaced?.id ?? this.newId(), kind: request.kind, path: request.path,
        recursive: request.kind === "folder" && request.recursive === true,
        format: request.format ?? single,
        excluded: [...new Set([
          ...(previous?.excluded.filter((path) => !matches.some((row) => row.path === path)) ?? []),
          ...matches.filter(({ excluded }) => excluded).map(({ path }) => path),
        ])],
      };
      section.sources = [...section.sources.filter(({ id }) => id !== source.id && id !== replaceSourceId), source];
    });
    const paths = new Set([...this.index.keys(), ...latest.map(({ path }) => path)]);
    for (const path of paths) await this.reconcile(path);
    return { confirmed: true } as const;
  }
}

type Choice = { checked?: boolean; format?: Format };
type PreviewChoice = (source: number, path: string) => Choice;

export class EnrollmentPreview {
  private readonly choices = new Map<number, Map<string, Choice>>();
  private rows: PlannedRow[] = [];

  constructor(
    private readonly requests: SourceRequest[],
    private readonly plan: (sources: SourceRequest[], getChoice: PreviewChoice,
      previous: PlannedRow[], affected?: ReadonlySet<string>) => Promise<PlannedRow[]>,
    private readonly apply: (sources: SourceRequest[], rows: PlannedRow[], getChoice: PreviewChoice) => Promise<Confirmation>,
  ) {}

  private choice = (source: number, path: string) => this.choices.get(source)?.get(path) ?? {};

  get sources(): readonly SourceRequest[] { return this.requests; }

  replaceSources(sources: readonly SourceRequest[]) {
    const previous = new Map(this.choices);
    this.choices.clear();
    for (const [index, source] of sources.entries()) {
      const oldIndex = this.requests.findIndex(({ kind, path }) => kind === source.kind && path === source.path);
      const old = this.requests[oldIndex];
      const choices = previous.get(oldIndex);
      if (!old || !choices) continue;
      const changedFormat = !sameFormat(old.format ?? single, source.format ?? single);
      this.choices.set(index, changedFormat
        ? new Map([...choices].map(([path, { checked }]) => [path, { checked }]))
        : choices);
    }
    this.requests.splice(0, this.requests.length, ...sources.map((source) => ({ ...source })));
    this.rows = [];
  }

  choose(source: number, path: string, choice: Choice) {
    let notes = this.choices.get(source);
    if (!notes) this.choices.set(source, notes = new Map());
    notes.set(path, { ...this.choice(source, path), ...choice });
  }

  rename(oldPath: string, newPath: string) {
    for (const request of this.requests) request.path = remapPath(request.path, oldPath, newPath);
    for (const notes of this.choices.values()) {
      for (const [path, choice] of [...notes]) {
        if (!hasPath(path, oldPath)) continue;
        notes.delete(path);
        notes.set(remapPath(path, oldPath, newPath), choice);
      }
    }
  }

  async refresh(affected?: ReadonlySet<string>): Promise<PreviewRow[]> {
    this.rows = await this.plan(this.requests, this.choice, this.rows, affected);
    return this.rows;
  }

  confirm(): Promise<Confirmation> {
    return this.apply(this.requests, this.rows, this.choice);
  }
}
