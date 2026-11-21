import { MarkdownNote, sameFormat, single, type Format, type MarkdownCard, type Status } from "./markdown";

export interface StudyVault {
  markdownFiles(): string[];
  folderExists(path: string): boolean;
  read(path: string): Promise<string>;
  process(path: string, edit: (source: string) => string): Promise<void>;
  hasUnsavedChanges(path: string, saved: string): boolean;
  create(path: string, source: string): Promise<void>;
  trash(path: string, validate: (source: string) => void): Promise<void>;
}

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

interface Section { id: string; name: string; sources: Source[] }
interface KnownCard { question: string; answerHash: number; id: string }
interface KnownNote { format: Format; cards: KnownCard[] }
export interface CardProgress { history?: unknown; schedule?: unknown }
export interface StudyData {
  sections: Section[];
  activeSection: string | null;
  knownNotes: Record<string, KnownNote>;
  progress: Record<string, CardProgress>;
}

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
  cards: MarkdownCard[];
  lines: { first: number; last: number }[];
  dirty: boolean;
  error?: string;
}

interface PlannedRow extends PreviewRow { text: string; excluded: boolean }
export type Confirmation = { confirmed: true } | { confirmed: false; paths: readonly string[] };

const emptyData: StudyData = { sections: [], activeSection: null, knownNotes: {}, progress: {} };
const hasPath = (path: string, parent: string) => parent === "" || path === parent || path.startsWith(parent + "/");
const samePath = (path: string, oldPath: string, newPath: string) => hasPath(path, oldPath)
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
  const previous = known && sameFormat(known.format, format) ? known.cards : [];
  const current = new Set(cards.map(({ id }) => id));
  const available = previous.filter(({ id }) => !current.has(id));
  const missing = cards.filter((card) => !card.id);
  const ids = new Map<MarkdownCard, string>();
  for (const card of missing) {
    const hash = answerHash(card.answer);
    const index = available.findIndex((old) => format.mode === "single" || old.question === card.question
      || (card.answer !== "" && old.answerHash === hash));
    if (index >= 0) ids.set(card, available.splice(index, 1)[0]!.id);
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
  private readonly index = new Map<string, IndexedNote>();
  private readonly listeners = new Set<() => void>();
  private queue = Promise.resolve<unknown>(undefined);
  private lastSaved: string;
  private revision = 0;

  constructor(
    private readonly vault: StudyVault,
    data: StudyData | undefined,
    private readonly save: (data: StudyData) => Promise<void>,
    private readonly newId: () => string,
  ) {
    this.data = { ...emptyData, ...data, knownNotes: { ...data?.knownNotes }, progress: { ...data?.progress } };
    this.lastSaved = JSON.stringify(this.data);
  }

  get sections(): readonly Section[] { return this.data.sections; }
  get activeSection() { return this.data.activeSection; }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const revision = this.revision;
      try {
        return await action();
      } finally {
        const data = JSON.stringify(this.data);
        const changed = data !== this.lastSaved;
        if (changed) {
          await this.save(this.data);
          this.lastSaved = data;
        }
        if (changed || revision !== this.revision) {
          for (const listener of this.listeners) listener();
        }
      }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private section(id: string) {
    const section = this.data.sections.find((item) => item.id === id);
    if (!section) throw new Error("Учебный раздел не найден");
    return section;
  }

  addSection(name: string) {
    return this.run(async () => {
      const title = name.trim();
      if (!title) throw new Error("Введите название учебного раздела");
      const id = this.newId();
      this.data.sections = [...this.data.sections, { id, name: title, sources: [] }];
      this.data.activeSection = id;
      return id;
    });
  }

  openSection(id: string) {
    return this.run(async () => {
      this.section(id);
      this.data.activeSection = id;
    });
  }

  removeSource(sectionId: string, sourceId: string) {
    return this.run(async () => {
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

  private memberships(path: string, note: MarkdownNote) {
    return this.data.sections.flatMap((section) => section.sources.flatMap((source) =>
      includesPath(source, path) && (source.kind === "file" || (note.marked && !source.excluded.includes(path)))
        ? [{ section: section.id, source }] : []));
  }

  private formats(note: MarkdownNote, defaults: Format[]) {
    const known = Object.hasOwn(this.data.knownNotes, note.path) ? this.data.knownNotes[note.path] : undefined;
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

  private indexNote(note: MarkdownNote, format: Format, sections: string[], error?: string) {
    const path = note.path;
    const known = Object.hasOwn(this.data.knownNotes, path) ? this.data.knownNotes[path] : undefined;
    const cards = error ? [] : note.cards(format);
    const missing = previousIds(cards, known, format);
    const indexed = this.index.get(path);
    if (indexed?.note.source === note.source && sameFormat(indexed.format, format) && indexed.error === error
      && sections.length === indexed.sections.length && sections.every((section) => indexed.sections.includes(section))) return;
    this.index.set(path, {
      note, format, sections, error,
      cards: cards.map((card, index) => ({
        ...card, path, index,
        identity: card.id ? "valid" : card.invalidId ? "invalid" : "missing",
      })),
    });
    this.revision++;
    if (!error && !this.vault.hasUnsavedChanges(path, note.source)) {
      const records = cards.flatMap((card) => {
        const id = card.id ?? missing.get(card);
        return id ? [{ question: card.question, answerHash: answerHash(card.answer), id }] : [];
      });
      this.data.knownNotes[path] = { format, cards: records };
    }
  }

  private removeFromIndex(path: string) {
    if (this.index.delete(path)) this.revision++;
  }

  private async reconcile(path: string, autoAssign = true, saved?: MarkdownNote) {
    if (!this.data.sections.some(({ sources }) => sources.some((source) => includesPath(source, path)))) {
      this.removeFromIndex(path);
      return;
    }
    let note = saved ?? await this.read(path);
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
    const known = Object.hasOwn(this.data.knownNotes, path) ? this.data.knownNotes[path] : undefined;
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
    this.indexNote(note, format, sections);
  }

  scan() {
    return this.run(async () => {
      const paths = new Set(this.vault.markdownFiles());
      for (const path of this.index.keys()) if (!paths.has(path)) this.removeFromIndex(path);
      for (const path of paths) await this.reconcile(path);
    });
  }

  update(path: string) {
    return this.run(() => this.reconcile(path));
  }

  delete(path: string) {
    return this.run(async () => {
      for (const key of this.index.keys()) if (hasPath(key, path)) this.removeFromIndex(key);
    });
  }

  rename(oldPath: string, newPath: string) {
    return this.run(async () => {
      for (const section of this.data.sections) {
        for (const source of section.sources) {
          source.path = samePath(source.path, oldPath, newPath);
          source.excluded = source.excluded.map((path) => samePath(path, oldPath, newPath));
        }
      }
      for (const path of Object.keys(this.data.knownNotes)) {
        if (!hasPath(path, oldPath)) continue;
        if (/\.md$/i.test(samePath(path, oldPath, newPath))) {
          this.data.knownNotes[samePath(path, oldPath, newPath)] = this.data.knownNotes[path]!;
        }
        delete this.data.knownNotes[path];
      }
      for (const path of this.index.keys()) if (hasPath(path, oldPath)) this.removeFromIndex(path);
      for (const path of this.vault.markdownFiles()) {
        if (hasPath(path, newPath)) await this.reconcile(path);
      }
    });
  }

  private allCards() {
    const cards = [...this.index.values()].flatMap((entry) => entry.cards);
    const counts = new Map<string, number>();
    for (const card of cards) if (card.id) counts.set(card.id, (counts.get(card.id) ?? 0) + 1);
    return cards.map((card): Card => card.id ? {
      ...card,
      identity: counts.get(card.id)! > 1 ? "duplicate" : "valid",
      progress: counts.get(card.id) === 1 ? this.data.progress[card.id] : undefined,
    } : card);
  }

  cards(sectionId: string) {
    return this.allCards().filter((card) => this.index.get(card.path)?.sections.includes(sectionId));
  }

  errors(sectionId: string) {
    return [...this.index.entries()].flatMap(([path, entry]) =>
      entry.error && entry.sections.includes(sectionId) ? [{ path, message: entry.error }] : []);
  }

  duplicates(id: string) {
    return this.allCards().filter((card) => card.id === id && card.identity === "duplicate");
  }

  canTrash(card: Card) {
    return this.index.get(card.path)?.format.mode === "single";
  }

  private currentCard(selected: Card) {
    const entry = this.index.get(selected.path);
    const card = entry?.cards[selected.index];
    if (!entry || !card || card.id !== selected.id || card.question !== selected.question
      || card.answer !== selected.answer || card.status !== selected.status) throw new ChangedNote(selected.path);
    return { entry, card };
  }

  setStatus(selected: Card, status: Status) {
    return this.run(async () => {
      const { entry } = this.currentCard(selected);
      const saved = await this.write(entry.note, (note) => note.setStatus(entry.format, selected.index, status));
      await this.reconcile(selected.path, false, saved);
    });
  }

  saveProgress(selected: Card, progress: CardProgress) {
    return this.run(async () => {
      const { entry } = this.currentCard(selected);
      const current = this.allCards().find((card) => card.path === selected.path && card.index === selected.index);
      if (!current?.id || current.identity !== "valid" || current.status === "invalid") {
        throw new Error("Исправьте UUID и статус освоения карточки");
      }
      const note = await this.read(current.path);
      if (!note || note.source !== entry.note.source || this.vault.hasUnsavedChanges(current.path, note.source)) {
        throw new ChangedNote(current.path);
      }
      this.data.progress[current.id] = progress;
    });
  }

  repairId(selected: Card) {
    return this.run(async () => {
      const { entry, card } = this.currentCard(selected);
      if (card.id) throw new Error("У карточки уже есть UUID");
      const saved = await this.write(entry.note, (note) => note.setId(entry.format, card.index, this.newId()));
      await this.reconcile(card.path, false, saved);
    });
  }

  resolveDuplicate(keep: Card, change: Card, action: "new-id" | "trash") {
    return this.run(async () => {
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
    return this.run(async () => {
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

  preview(sectionId: string, requests: SourceRequest[]) {
    this.section(sectionId);
    return new EnrollmentPreview(requests.map((request) => ({ ...request })),
      (sources, getChoice, previous, affected) => this.plan(sectionId, sources, getChoice, previous, affected),
      (sources, rows, getChoice) => this.run(() => this.enroll(sectionId, sources, rows, getChoice)));
  }

  private async plan(sectionId: string, requests: SourceRequest[], getChoice: PreviewChoice,
    previous: PlannedRow[] = [], affected?: ReadonlySet<string>) {
    const paths = this.vault.markdownFiles().sort((a, b) => a.localeCompare(b));
    const rows: PlannedRow[] = [];
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
      if (affected && !affected.has(path) && unchanged && unchanged.length === sources.length
        && unchanged.every(({ source }) => sources.includes(source))) {
        rows.push(...unchanged);
        continue;
      }
      const note = await this.read(path);
      if (!note) continue;
      const items = sources.map((source) => {
        const request = requests[source]!;
        const existing = request.kind === "folder" && this.section(sectionId).sources.some((item) =>
          item.kind === "folder" && item.path === request.path && item.excluded.includes(path));
        const choice = getChoice(source, path);
        return {
          source, choice, checked: choice.checked ?? (request.kind === "file" || (note.marked && !existing)),
          excluded: choice.checked === false || (choice.checked === undefined && existing),
        };
      });
      const defaults = [
        ...this.memberships(path, note).map(({ source }) => source.format),
        ...items.filter(({ checked }) => checked).map(({ source }) => requests[source]!.format ?? single),
      ];
      const chosen = items.find(({ checked, choice }) => checked && choice.format)?.choice.format;
      const dirty = this.vault.hasUnsavedChanges(path, note.source);
      for (const { source, checked, choice, excluded } of items) {
        const formats = this.formats(note, defaults.length ? defaults : [requests[source]!.format ?? single]);
        const choiceFormat = chosen ?? choice.format;
        const selected = formats.find((item) => choiceFormat && sameFormat(item, choiceFormat));
        const cards = note.error ? [] : note.cards(selected ?? formats[0]!);
        const lines = cards.map(({ from, to }) => ({
          first: note.lineAt(from),
          last: note.lineAt(Math.max(from, to - 1)),
        }));
        rows.push({
          path, source, checked, format: selected ?? formats[0]!, formats, needsFormat: formats.length > 1 && !selected,
          cards, lines, text: note.source, error: note.error, dirty, excluded,
        });
      }
    }
    return rows;
  }

  private async enroll(sectionId: string, requests: SourceRequest[], rows: PlannedRow[], getChoice: PreviewChoice) {
    const section = this.section(sectionId);
    const missingFolders = () => requests.flatMap(({ kind, path }) =>
      kind === "folder" && !this.vault.folderExists(path) ? [path] : []);
    const latest = await this.plan(sectionId, requests, getChoice);
    const stale = new Set(missingFolders());
    const key = ({ path, source }: PlannedRow) => JSON.stringify([source, path]);
    const baseline = new Map(rows.map((row) => [key(row), row]));
    for (const row of latest) {
      const old = baseline.get(key(row));
      if (!old || old.text !== row.text || old.checked !== row.checked || old.excluded !== row.excluded || !sameFormat(old.format, row.format)
        || (row.checked && (row.dirty || row.error || row.needsFormat))) stale.add(row.path);
      baseline.delete(key(row));
    }
    for (const row of baseline.values()) stale.add(row.path);
    if (stale.size) return { confirmed: false, paths: [...stale] } as const;

    const eligible = new Map(latest.filter(({ checked }) => checked).map((row) => [row.path, row]));
    for (const row of eligible.values()) {
      const note = new MarkdownNote(row.path, row.text);
      try {
        await this.write(note, (current) => current.enroll(row.format,
          this.assign(current, row.format, Object.hasOwn(this.data.knownNotes, row.path) ? this.data.knownNotes[row.path] : undefined)));
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
        id: previous?.id ?? this.newId(), kind: request.kind, path: request.path,
        recursive: request.kind === "folder" && request.recursive === true,
        format: request.format ?? single,
        excluded: [...new Set([
          ...(previous?.excluded.filter((path) => !matches.some((row) => row.path === path)) ?? []),
          ...matches.filter(({ excluded }) => excluded).map(({ path }) => path),
        ])],
      };
      section.sources = [...section.sources.filter(({ id }) => id !== source.id), source];
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

  choose(source: number, path: string, choice: Choice) {
    let notes = this.choices.get(source);
    if (!notes) this.choices.set(source, notes = new Map());
    notes.set(path, { ...this.choice(source, path), ...choice });
  }

  rename(oldPath: string, newPath: string) {
    for (const request of this.requests) request.path = samePath(request.path, oldPath, newPath);
    for (const notes of this.choices.values()) {
      for (const [path, choice] of [...notes]) {
        if (!hasPath(path, oldPath)) continue;
        notes.delete(path);
        notes.set(samePath(path, oldPath, newPath), choice);
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
