import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { StudyStorage, type StudyStorageIO } from "../src/study-storage";

function device(file: { raw: string | null }) {
  let local: unknown;
  let failCheckpoint = false;
  let write: ((apply: () => void) => void | Promise<void>) | undefined;
  const io: StudyStorageIO = {
    async readShared() { return file.raw; },
    async writeShared(expected, next) {
      const apply = () => {
        if (file.raw !== expected) throw new Error("changed");
        file.raw = next;
      };
      if (write) await write(apply);
      else apply();
    },
    async readDevice() { return structuredClone(local); },
    async writeDevice(next) {
      if (failCheckpoint) {
        failCheckpoint = false;
        throw new Error("local checkpoint interrupted");
      }
      local = structuredClone(next);
    },
  };
  return {
    open: (legacy?: unknown) => StudyStorage.open(io, legacy, randomUUID),
    beforeWrite(hook?: typeof write) { write = hook; },
    failNextDeviceWrite() { failCheckpoint = true; },
  };
}

test("повторяет прерванную миграцию и сохраняет UUID, расписание и последний открытый раздел", async () => {
  const file = { raw: null as string | null };
  const desktop = device(file);
  const section = randomUUID();
  const uuid = randomUUID();
  const legacy = {
    activeSection: section,
    sections: [{ id: section, name: "Курс", sources: [] }],
    knownNotes: {},
    progress: { [uuid]: { history: [{ score: 3 }], schedule: { due: 15 } } },
  };

  desktop.beforeWrite(() => { throw new Error("disk full"); });
  const interrupted = await desktop.open(legacy);
  assert.equal(file.raw, null);
  assert.equal(interrupted.state.problem?.kind, "recovery");
  assert.deepEqual(interrupted.state.data.progress, legacy.progress);

  desktop.beforeWrite();
  const reopened = await desktop.open(legacy);
  assert.equal(reopened.state.problem, null);
  assert.deepEqual(reopened.state.data.sections, legacy.sections);
  assert.deepEqual(reopened.state.data.progress, legacy.progress);
  assert.equal(reopened.activeSection, section);
  assert.ok(file.raw);
  assert.equal(JSON.parse(file.raw).data.activeSection, undefined);
  assert.deepEqual(reopened.legacyBackup, legacy);
  const migrated = file.raw;
  await desktop.open(legacy);
  assert.equal(file.raw, migrated);
});

test("блокирует запись при расхождении и передаёт выбор второй копии", async () => {
  const left = { raw: null as string | null };
  const right = { raw: null as string | null };
  const desktop = await device(left).open();
  const section = { id: randomUUID(), name: "Курс", sources: [] };
  const save = (store: StudyStorage, name: string) => store.commit({
    id: randomUUID(), revision: store.state.revision, action: name,
  }, (draft) => { draft.sections = [{ ...section, name }]; });
  await save(desktop, "Курс");
  right.raw = left.raw;
  const mobile = await device(right).open();
  await save(desktop, "Компьютер");
  const desktopFile = left.raw;
  await save(mobile, "Телефон");
  const mobileFile = right.raw;
  left.raw = mobileFile;
  await desktop.refresh();
  const problem = desktop.state.problem;
  assert.equal(problem?.kind, "conflict");
  assert.deepEqual(problem?.versions.map(({ action }) => action).sort(), ["Компьютер", "Телефон"]);
  await assert.rejects(save(desktop, "Новая запись"), /Выберите рабочую версию/);
  left.raw = null;
  await desktop.refresh();
  assert.equal(desktop.problem?.kind, "conflict");
  await assert.rejects(desktop.restore(desktop.state.token, true), /изменились/);
  assert.equal(left.raw, null);
  const selected = problem?.versions.find(({ action }) => action === "Компьютер");
  await desktop.choose(desktop.state.token, selected!.id);
  right.raw = left.raw;
  await mobile.refresh();
  assert.equal(mobile.state.problem, null);
  assert.equal(mobile.state.data.sections[0]?.name, "Компьютер");
  left.raw = mobileFile;
  await desktop.refresh();
  assert.equal(desktop.state.problem, null);
  assert.equal(desktop.state.data.sections[0]?.name, "Компьютер");
  left.raw = desktopFile;
  await desktop.refresh();
  assert.equal(desktop.state.problem, null);
});

test("при исчезновении, повреждении или новом формате показывает копию и сохраняет исходный файл", async () => {
  const file = { raw: null as string | null };
  const desktop = device(file);
  let storage = await desktop.open();
  assert.equal(storage.state.problem, null);
  const id = randomUUID();
  const save = () => storage.commit({ id: randomUUID(), revision: storage.state.revision, action: "Добавление раздела" },
    (draft) => { draft.sections.push({ id, name: "Курс", sources: [] }); });
  await save();
  const original = file.raw;
  file.raw = null;
  storage = await desktop.open();
  assert.equal(storage.state.problem?.kind, "recovery");
  assert.ok(storage.state.problem?.backup?.savedAt);
  assert.equal(storage.state.data.sections[0]?.id, id);
  await assert.rejects(save(), /Восстановите/);
  assert.equal(file.raw, null);

  file.raw = original!.replace("Курс", "Подмена");
  const damaged = file.raw;
  await storage.refresh();
  assert.equal(storage.state.problem?.kind, "recovery");
  assert.equal(storage.state.problem?.reason, "damaged");
  assert.equal(file.raw, damaged);
  await storage.restore(storage.state.token, true);
  assert.equal(storage.state.problem, null);
  assert.equal(storage.state.data.sections[0]?.name, "Курс");
  assert.ok(file.raw);

  const future = JSON.stringify({ version: 7, data: {} });
  file.raw = future;
  await storage.refresh();
  assert.equal(storage.problem?.kind, "unsupported");
  await assert.rejects(save(), /совместимой версией/);
  await assert.rejects(storage.restore(storage.state.token, true), /совместимой версией/);
  assert.equal(file.raw, future);
});

test("без исправной копии пустое состояние создаётся только после подтверждения", async () => {
  const file = { raw: "{\n" as string | null };
  const desktop = device(file);
  await desktop.open();
  file.raw = null;
  const storage = await desktop.open();
  assert.equal(storage.state.problem?.kind, "recovery");
  assert.equal(storage.state.problem?.backup, null);
  assert.equal(file.raw, null);
  await storage.restore(storage.state.token, false);
  assert.equal(storage.state.problem, null);
  assert.ok(file.raw);
});

test("предпросмотр импорта устаревает, а подтверждение сохраняет копию перед заменой", async () => {
  const file = { raw: null as string | null };
  const desktop = await device(file).open();
  const add = (storage: StudyStorage, name: string) => storage.commit({
    id: randomUUID(), revision: storage.state.revision, action: name,
  }, (draft) => { draft.sections.push({ id: randomUUID(), name, sources: [] }); });
  await add(desktop, "Первый");
  const older = await desktop.export();
  const outdated = await desktop.previewImport(older);
  const second = await device(file).open();
  await add(second, "Свежий");
  const newest = file.raw;
  await assert.rejects(desktop.import(outdated), /изменились/);
  assert.equal(file.raw, newest);
  const preview = await desktop.previewImport(older);
  assert.deepEqual(preview.incoming.sections, ["Первый"]);
  assert.deepEqual(preview.current?.sections, ["Первый", "Свежий"]);
  await assert.rejects(desktop.previewImport("{"), /повреждён/);
  await assert.rejects(desktop.previewImport(JSON.stringify({ exportedAt: preview.exportedAt, snapshot: { version: 9 } })),
    /совместимой версией/);
  assert.equal(file.raw, newest);
  await desktop.import(preview);
  assert.deepEqual(desktop.state.data.sections.map(({ name }) => name), ["Первый"]);
  const copy = await desktop.previewImport(desktop.exportBeforeImport());
  assert.deepEqual(copy.incoming.sections, ["Первый", "Свежий"]);
  await second.refresh();
  assert.equal(second.state.problem, null);
  assert.deepEqual(second.state.data.sections.map(({ name }) => name), ["Первый"]);
});

test("локальная навигация независима, действие на устаревшей версии отклоняется", async () => {
  const file = { raw: null as string | null };
  const desktop = await device(file).open();
  const a = { id: randomUUID(), name: "Первый", sources: [] };
  const b = { id: randomUUID(), name: "Второй", sources: [] };
  const mutation = (storage: StudyStorage) => ({ id: randomUUID(), revision: storage.state.revision, action: "Настройка" });
  await desktop.commit(mutation(desktop), (draft) => { draft.sections = [a, b]; });
  const mobile = await device(file).open();
  await desktop.openSection(a.id);
  await mobile.openSection(b.id);
  assert.equal(desktop.activeSection, a.id);
  assert.equal(mobile.activeSection, b.id);
  const stale = mutation(desktop);
  await mobile.commit(mutation(mobile), (draft) => { draft.sections[0]!.name = "С телефона"; });
  await assert.rejects(desktop.commit(stale, (draft) => { draft.sections[0]!.name = "С компьютера"; }), /изменились/);
  assert.equal(desktop.state.data.sections[0]?.name, "С телефона");
  assert.equal(desktop.activeSection, a.id);
});

test("предлагает запись без подтверждения после подмены общего файла перед запуском", async () => {
  const firstFile = { raw: null as string | null };
  const desktop = device(firstFile);
  const original = await desktop.open();
  const section = { id: randomUUID(), name: "Курс", sources: [] };
  const setName = (store: StudyStorage, name: string) => store.commit({
    id: randomUUID(), revision: store.state.revision, action: name,
  }, (draft) => { draft.sections = [{ ...section, name }]; });
  await setName(original, "Курс");
  const mobileFile = { raw: firstFile.raw };
  const mobile = await device(mobileFile).open();
  await setName(mobile, "Телефон");

  desktop.beforeWrite((apply) => {
    apply();
    desktop.failNextDeviceWrite();
  });
  await assert.rejects(setName(original, "Компьютер"), /Повторите действие/);
  firstFile.raw = mobileFile.raw;
  desktop.beforeWrite();
  const reopened = await desktop.open();
  const problem = reopened.problem;
  assert.equal(problem?.kind, "conflict");
  assert.equal(reopened.state.data.sections[0]?.name, "Телефон");
  const draft = problem?.versions.find(({ action }) => action === "Компьютер");
  assert.equal(draft?.unconfirmed, true);
  await reopened.choose(reopened.state.token, draft!.id);
  assert.equal(reopened.state.data.sections[0]?.name, "Компьютер");
  assert.equal(reopened.problem, null);
});

test("повтор уже опубликованного импорта сохраняет исходную копию после сбоя локальной записи", async () => {
  const file = { raw: null as string | null };
  const deviceStorage = device(file);
  const store = await deviceStorage.open();
  const save = (name: string) => store.commit({
    id: randomUUID(), revision: store.state.revision, action: name,
  }, (draft) => { draft.sections = [{ id: randomUUID(), name, sources: [] }]; });
  await save("Из экспорта");
  const exported = await store.export();
  await save("Перед импортом");
  const preview = await store.previewImport(exported);
  deviceStorage.beforeWrite((apply) => { apply(); deviceStorage.failNextDeviceWrite(); });
  await assert.rejects(store.import(preview), /Повторите действие/);
  const applied = file.raw;
  deviceStorage.beforeWrite();
  await store.import(preview);
  assert.equal(file.raw, applied);
  assert.deepEqual(store.state.data.sections.map(({ name }) => name), ["Из экспорта"]);
  const backup = await store.previewImport(store.exportBeforeImport());
  assert.deepEqual(backup.incoming.sections, ["Перед импортом"]);
});

test("прежние локальные данные рядом с общим файлом требуют выбора версии", async () => {
  const file = { raw: null as string | null };
  const first = await device(file).open();
  await first.commit({ id: randomUUID(), revision: first.state.revision, action: "Общий файл" },
    (draft) => { draft.sections = [{ id: randomUUID(), name: "Общий раздел", sources: [] }]; });
  const shared = file.raw;
  const section = { id: randomUUID(), name: "Прежний раздел", sources: [] };
  const local = { sections: [section], activeSection: section.id, knownNotes: {}, progress: {} };
  const secondDevice = device(file);
  let store = await secondDevice.open(local);
  assert.equal(store.problem?.kind, "conflict");
  assert.equal(file.raw, shared);
  store = await secondDevice.open(local);
  const conflict = store.problem;
  assert.equal(conflict?.kind, "conflict");
  assert.equal(conflict?.versions.length, 2);
  const previous = conflict?.versions.find(({ sections }) => sections.includes(section.name));
  await store.choose(store.state.token, previous!.id);
  assert.deepEqual(store.legacyBackup, local);
  assert.deepEqual(store.state.data.sections, [section]);
  await first.refresh();
  assert.equal(first.problem, null);
  assert.deepEqual(first.state.data.sections, [section]);
});
