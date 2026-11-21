import { emptyStudyData, isDate, legacyStudyData, record, stringList, validStudyData, type StudyData } from "./study-state";

export const sharedStudyPath = "Study Cards/data.json";
const version = 1;

interface Revision {
  version: typeof version;
  id: string;
  ancestors: string[];
  superseded: string[];
  savedAt: string;
  action: string;
  data: StudyData;
}

interface Snapshot extends Revision { checksum: string }

interface PendingWrite {
  snapshot: Snapshot;
  base: string | null;
  notApplied: boolean;
  beforeImport: Snapshot | null;
}

interface DeviceState {
  known: boolean;
  activeSection: string | null;
  head: Snapshot | null;
  branches: Snapshot[];
  pending: PendingWrite | null;
  uncertain: PendingWrite[];
  migration: Snapshot | null;
  legacy: unknown;
  damaged: string | null;
  beforeImport: Snapshot | null;
}

// Adapters use this error only when they can establish that publication did not start.
export class SharedWriteNotApplied extends Error {}

export interface StudyStorageIO {
  readShared(): Promise<string | null>;
  writeShared(expected: string | null, next: string): Promise<void>;
  readDevice(): Promise<unknown>;
  writeDevice(next: unknown): Promise<void>;
}

export interface SnapshotSummary {
  id: string;
  savedAt: string;
  action: string;
  sections: string[];
  intervalReviews: number;
  freeResults: number;
  pendingCheck: { answered: number; total: number; retry: boolean } | null;
  unconfirmed?: boolean;
}

export type StorageProblem =
  | { kind: "conflict"; versions: SnapshotSummary[]; canStartEmpty: boolean }
  | { kind: "recovery"; reason: "missing" | "damaged" | "migration"; backup: SnapshotSummary | null }
  | { kind: "unsupported"; version: number };

export interface StorageState {
  revision: string | null;
  token: number;
  data: StudyData;
  problem: StorageProblem | null;
}

export interface StudyMutation {
  revision: string | null;
  id: string;
  action: string;
}

export class StaleStudyState extends Error {
  constructor() { super("Данные Study Cards изменились. Проверьте актуальное состояние и повторите действие."); }
}

class UnsupportedVersion extends Error {
  constructor(readonly version: number) {
    super(`Формат Study Cards ${version} не поддерживается. Откройте данные совместимой версией плагина.`);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  return record(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
}

async function hash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const checksum = (revision: Revision) => hash(JSON.stringify(canonical(revision)));
const fingerprint = (raw: string | null) => raw === null ? null : hash(raw);

async function validateSnapshot(value: unknown): Promise<Snapshot> {
  if (record(value) && typeof value.version === "number" && value.version > version) {
    throw new UnsupportedVersion(value.version);
  }
  if (record(value) && value.version === version && typeof value.id === "string" && value.id
    && stringList(value.ancestors) && stringList(value.superseded) && isDate(value.savedAt)
    && typeof value.action === "string" && validStudyData(value.data) && typeof value.checksum === "string") {
    const snapshot = value as unknown as Snapshot;
    const { checksum: signature, ...revision } = snapshot;
    const superseded = new Set(revision.superseded);
    if (!superseded.has(revision.id) && !revision.ancestors.includes(revision.id)
      && !revision.ancestors.some((id) => superseded.has(id)) && await checksum(revision) === signature) {
      return snapshot;
    }
  }
  throw new Error("Файл Study Cards повреждён или имеет неизвестный формат.");
}

async function backup(value: unknown) {
  return validateSnapshot(value).catch(() => null);
}

async function pendingWrite(value: unknown): Promise<PendingWrite | null> {
  if (!record(value) || (value.base !== null && typeof value.base !== "string")) return null;
  const [snapshot, beforeImport] = await Promise.all([backup(value.snapshot), backup(value.beforeImport)]);
  return snapshot && { snapshot, base: value.base, notApplied: value.notApplied === true, beforeImport };
}

const serialize = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

function summarize(snapshot: Snapshot): SnapshotSummary {
  const { id, savedAt, action, data } = snapshot;
  return {
    id, savedAt, action,
    sections: data.sections.map(({ name }) => name),
    intervalReviews: Object.values(data.progress).reduce((count, card) =>
      count + (card.reviews?.length ?? 0) + (Array.isArray(card.history) ? card.history.length : 0), 0),
    freeResults: data.freeResults.length,
    pendingCheck: data.freeSession && {
      answered: Object.keys(data.freeSession.grades).length,
      total: data.freeSession.cardIds.length,
      retry: data.freeSession.retryOf !== null,
    },
  };
}

function includesRevision(snapshot: Snapshot, id: string) {
  return snapshot.id === id || snapshot.ancestors.includes(id);
}

function latestVersions(snapshots: Snapshot[]) {
  const unique = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const reviewed = new Set(snapshots.flatMap(({ ancestors, superseded }) => [...ancestors, ...superseded]));
  return [...unique.values()].filter(({ id }) => !reviewed.has(id));
}

function operationFailed(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error("Не удалось сохранить данные Study Cards. Повторите действие. " + detail);
}

export class StudyStorage {
  private queue = Promise.resolve<unknown>(undefined);
  private raw: string | null | undefined;
  private mustVerifyPending = false;
  private current: StorageState = { revision: null, token: 0, data: emptyStudyData(), problem: null };
  private readonly imports = new WeakMap<ImportPreview, { snapshot: Snapshot; id: string }>();

  private constructor(private readonly io: StudyStorageIO, private device: DeviceState, private readonly newId: () => string) {}

  static async open(io: StudyStorageIO, legacy: unknown, newId: () => string) {
    const local = await io.readDevice();
    const saved = record(local) ? local : {};
    const [head, pending, uncertain, migration, beforeImport, branches] = await Promise.all([
      backup(saved.head), pendingWrite(saved.pending),
      Promise.all((Array.isArray(saved.uncertain) ? saved.uncertain : [saved.uncertain]).map(pendingWrite)),
      backup(saved.migration), backup(saved.beforeImport),
      Promise.all((Array.isArray(saved.branches) ? saved.branches : []).map(backup)),
    ]);
    const device: DeviceState = {
      known: saved.known === true || saved.head != null,
      activeSection: typeof saved.activeSection === "string" ? saved.activeSection : null,
      head, pending, migration, beforeImport,
      uncertain: uncertain.filter((candidate) => candidate !== null),
      legacy: saved.legacy ?? null,
      damaged: typeof saved.damaged === "string" ? saved.damaged : null,
      branches: branches.filter((branch) => branch !== null),
    };
    const store = new StudyStorage(io, device, newId);
    if (device.legacy === null && legacy != null) {
      const old = legacyStudyData(legacy);
      const candidate = old && await store.makeRevision(newId(), "Миграция данных плагина", old.data);
      await store.saveDevice({
        ...device, legacy, migration: candidate,
        activeSection: device.activeSection ?? old?.activeSection ?? null,
      });
    }
    await store.readLatest(true);
    if (store.raw === null && !store.device.known && store.device.migration) {
      try {
        await store.publish(store.device.migration);
      } catch {
        // The original and the same migration revision remain available for retry.
      }
    }
    return store;
  }

  get state(): StorageState { return structuredClone(this.current); }
  get token() { return this.current.token; }
  get problem(): StorageProblem | null { return structuredClone(this.current.problem); }
  get revision() { return this.current.revision; }
  wasCommitted(id: string) { return this.device.head !== null && includesRevision(this.device.head, id); }
  get activeSection() { return this.device.activeSection; }
  get legacyBackup(): unknown { return structuredClone(this.device.legacy); }
  get hasBeforeImport() { return this.device.beforeImport !== null; }

  openSection(id: string) {
    return this.run(() => this.saveDevice({ ...this.device, activeSection: id }));
  }

  refresh() {
    return this.run(() => this.readLatest());
  }

  async commit(mutation: StudyMutation, update: (data: StudyData) => StudyData | void) {
    return this.run(async () => {
      await this.readLatest();
      const { head } = this.device;
      if (head && includesRevision(head, mutation.id)) return;
      if ((head?.id ?? null) !== mutation.revision || head?.superseded.includes(mutation.id)) throw new StaleStudyState();
      this.ensureWritable();
      const draft = structuredClone(this.current.data);
      const data = update(draft) ?? draft;
      const pending = this.device.pending?.snapshot;
      const candidate = pending?.id === mutation.id && (pending.ancestors[pending.ancestors.length - 1] ?? null) === mutation.revision
        ? pending
        : await this.makeRevision(mutation.id, mutation.action, data, head);
      await this.publish(candidate);
    });
  }

  assertWritable() { this.ensureWritable(); }

  export() {
    return this.run(async () => {
      await this.readLatest();
      const snapshot = this.device.head ?? this.device.migration
        ?? await this.makeRevision(this.newId(), "Пустое состояние", emptyStudyData());
      return this.exportSnapshot(snapshot);
    });
  }

  exportBeforeImport() {
    const snapshot = this.device.beforeImport;
    if (!snapshot) throw new Error("Копия до импорта отсутствует.");
    return this.exportSnapshot(snapshot);
  }

  previewImport(raw: string) {
    return this.run(async () => {
      const value: unknown = JSON.parse(raw);
      if (!record(value) || !isDate(value.exportedAt)) throw new Error("Выберите экспортированный снимок Study Cards.");
      const snapshot = await validateSnapshot(value.snapshot);
      await this.readLatest();
      const current = this.device.head ?? this.device.migration;
      const preview: ImportPreview = {
        token: this.current.token,
        exportedAt: value.exportedAt,
        incoming: summarize(snapshot),
        current: current && summarize(current),
      };
      this.imports.set(preview, { snapshot, id: this.newId() });
      return preview;
    }).catch((error: unknown) => {
      if (error instanceof SyntaxError) throw new Error("Файл импорта Study Cards повреждён.");
      throw error;
    });
  }

  import(preview: ImportPreview) {
    return this.run(async () => {
      const entry = this.imports.get(preview);
      if (!entry) throw new Error("Откройте предпросмотр импорта.");
      await this.readLatest();
      if (this.wasCommitted(entry.id)) return;
      this.checkToken(preview.token);
      if (this.current.problem?.kind === "conflict") this.ensureWritable();
      const head = this.device.head ?? this.device.migration;
      const pending = this.device.pending;
      const candidate = pending?.snapshot.id === entry.id ? pending.snapshot
        : await this.makeRevision(entry.id, "Импорт снимка", entry.snapshot.data, head, [entry.snapshot]);
      await this.publish(candidate, head);
    });
  }

  choose(token: number, id: string) {
    return this.run(async () => {
      await this.readLatest();
      this.checkToken(token);
      const versions = this.availableVersions(this.device);
      const selected = versions.find((item) => item.id === id);
      if (this.current.problem?.kind !== "conflict" || !selected) throw new StaleStudyState();
      const candidate = await this.makeRevision(this.newId(), "Выбор версии", selected.data, selected, versions);
      const uncertain = this.device.uncertain.find(({ snapshot }) => snapshot.id === selected.id);
      await this.publish(candidate, uncertain?.beforeImport ?? null);
    });
  }

  restore(token: number, useBackup: boolean) {
    return this.run(async () => {
      await this.readLatest();
      this.checkToken(token);
      const problem = this.current.problem;
      if (problem?.kind !== "recovery" && !(problem?.kind === "conflict" && problem.canStartEmpty && !useBackup)) {
        throw new StaleStudyState();
      }
      const head = this.device.head ?? this.device.migration;
      if (useBackup !== Boolean(head)) throw new StaleStudyState();
      const data = head?.data ?? emptyStudyData();
      const candidate = await this.makeRevision(this.newId(), head ? "Восстановление копии" : "Создание состояния",
        data, head, this.availableVersions(this.device));
      await this.publish(candidate);
    });
  }

  private run<T>(operation: () => Promise<T>) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async saveDevice(next: DeviceState) {
    await this.io.writeDevice(next);
    this.device = next;
  }

  private ensureWritable() {
    const problem = this.current.problem;
    if (problem?.kind === "unsupported") throw new UnsupportedVersion(problem.version);
    if (problem?.kind === "conflict") throw new Error("Выберите рабочую версию Study Cards перед сохранением.");
    if (problem?.kind === "recovery") throw new Error("Восстановите данные Study Cards перед сохранением.");
  }

  private checkToken(token: number) {
    if (token !== this.current.token) throw new StaleStudyState();
    const problem = this.current.problem;
    if (problem?.kind === "unsupported") throw new UnsupportedVersion(problem.version);
  }

  private exportSnapshot(snapshot: Snapshot) {
    return serialize({ exportedAt: new Date().toISOString(), snapshot });
  }

  private async makeRevision(id: string, action: string, data: StudyData, parent?: Snapshot | null, reviewed: Snapshot[] = []) {
    // Round-trip through JSON so the local copy and the vault contain the same data.
    const normalized: unknown = JSON.parse(JSON.stringify(data));
    if (!validStudyData(normalized)) throw new Error("Недопустимое состояние Study Cards.");
    const ancestors = parent ? [...parent.ancestors, parent.id] : [];
    const lineage = new Set(ancestors);
    const superseded = new Set(parent?.superseded);
    for (const branch of reviewed) {
      for (const seen of [branch.id, ...branch.ancestors, ...branch.superseded]) {
        if (!lineage.has(seen)) superseded.add(seen);
      }
    }
    const revision: Revision = { version, id, ancestors, superseded: [...superseded],
      savedAt: new Date().toISOString(), action, data: normalized };
    return { ...revision, checksum: await checksum(revision) };
  }

  private async readLatest(startup = false) {
    await this.observe(await this.io.readShared(), startup || this.mustVerifyPending);
  }

  private availableVersions(device: DeviceState) {
    const { head, branches, migration, uncertain } = device;
    return [...new Map([head, ...branches, migration, ...uncertain.map(({ snapshot }) => snapshot)]
      .filter((item) => item !== null).map((item) => [item.id, item])).values()];
  }

  private async settlePending(device: DeviceState, incoming: Snapshot | null, raw: string | null, interrupted: boolean) {
    let next = device;
    const { pending, uncertain, migration } = next;
    if (incoming && uncertain.length) {
      let beforeImport = next.beforeImport;
      const remaining = uncertain.filter(({ snapshot, beforeImport: copy }) => {
        if (includesRevision(incoming, snapshot.id)) {
          beforeImport = copy ?? beforeImport;
          return false;
        }
        return !incoming.superseded.includes(snapshot.id);
      });
      next = { ...next, uncertain: remaining, beforeImport };
    }
    if (!pending) return next;
    const id = pending.snapshot.id;
    if (incoming && (includesRevision(incoming, id) || incoming.superseded.includes(id))) {
      return { ...next, pending: null,
        beforeImport: includesRevision(incoming, id) ? pending.beforeImport ?? next.beforeImport : next.beforeImport };
    }
    // Only a matching shared version can confirm a write that was interrupted at the device checkpoint.
    // If sync changed the file before we could check, keep the tentative copy for an explicit choice.
    if (!pending.notApplied && migration?.id !== id
      && (interrupted || await fingerprint(raw) !== pending.base)) {
      return { ...next, pending: null, uncertain: [...next.uncertain, pending] };
    }
    return next;
  }

  private async observe(raw: string | null, interrupted = false) {
    if (raw === this.raw && !interrupted) return;
    let next = this.device;
    let incoming: Snapshot | null = null;
    let problem: StorageProblem | null = null;

    if (raw === null) {
      if (next.known || next.migration || next.legacy !== null) {
        const copy = next.head ?? next.migration;
        problem = { kind: "recovery", reason: next.migration ? "migration" : "missing", backup: copy && summarize(copy) };
      }
    } else {
      try {
        incoming = await validateSnapshot(JSON.parse(raw));
        const known = [...this.availableVersions(next), next.pending?.snapshot].find((item) => item?.id === incoming?.id);
        if (known && known.checksum !== incoming.checksum) throw new Error("Данные версии изменены.");
      } catch (error) {
        incoming = null;
        next = { ...next, known: true, damaged: raw };
        const copy = next.head ?? next.migration;
        problem = error instanceof UnsupportedVersion ? { kind: "unsupported", version: error.version }
          : { kind: "recovery", reason: "damaged", backup: copy && summarize(copy) };
      }
    }

    next = await this.settlePending(next, incoming, raw, interrupted);
    if (incoming) {
      let migration = next.migration;
      if (migration && JSON.stringify(canonical(migration.data)) === JSON.stringify(canonical(incoming.data))) migration = null;
      const available = latestVersions([next.head, ...next.branches, migration, incoming].filter((item) => item !== null));
      next = {
        ...next,
        known: true,
        head: available.find(({ id }) => id === next.head?.id) ?? available[0] ?? incoming,
        branches: available.length > 1 ? available : [],
        migration: null,
      };
    }
    if (problem?.kind !== "unsupported" && (next.branches.length > 1 || next.uncertain.length > 0)) {
      problem = {
        kind: "conflict",
        versions: this.availableVersions(next).map((item) => ({
          ...summarize(item), unconfirmed: next.uncertain.some(({ snapshot }) => snapshot.id === item.id),
        })),
        canStartEmpty: !next.head && !next.migration,
      };
    }

    if (next !== this.device) await this.saveDevice(next);
    this.raw = raw;
    this.mustVerifyPending = false;
    const head = next.head ?? next.migration;
    this.current = { revision: head?.id ?? null, token: this.current.token + 1, data: head?.data ?? emptyStudyData(), problem };
  }

  private async publish(snapshot: Snapshot, beforeImport: Snapshot | null = null) {
    const expected = this.raw ?? null;
    const pending = { snapshot, base: await fingerprint(expected), notApplied: false, beforeImport };
    try {
      await this.saveDevice({ ...this.device, pending });
      await this.io.writeShared(expected, serialize(snapshot));
    } catch (error) {
      if (this.device.pending !== pending) throw operationFailed(error);
      try {
        if (error instanceof SharedWriteNotApplied) {
          await this.saveDevice({ ...this.device, pending: { ...pending, notApplied: true } });
        } else {
          this.mustVerifyPending = true;
        }
        await this.readLatest();
        if (this.wasCommitted(snapshot.id)) return;
      } catch {
        throw operationFailed(error);
      }
      if (this.raw !== expected && this.current.problem?.kind !== "recovery") throw new StaleStudyState();
      throw operationFailed(error);
    }
    this.mustVerifyPending = true;
    try {
      await this.observe(serialize(snapshot));
    } catch (error) {
      throw operationFailed(error);
    }
  }
}

export interface ImportPreview {
  readonly token: number;
  readonly exportedAt: string;
  readonly incoming: SnapshotSummary;
  readonly current: SnapshotSummary | null;
}
