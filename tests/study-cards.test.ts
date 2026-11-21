import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { StudyCards, type StudyVault } from "../src/study-cards";

import { StudyStorage, type StudyStorageIO } from "../src/study-storage";

async function testVault() {
  const root = await mkdtemp(join(tmpdir(), "study-cards-"));
  const paths = new Set<string>();
  let state: string | null = null;
  let local: unknown;
  let persistHook: ((apply: () => void) => void | Promise<void>) | undefined;
  const io: StudyStorageIO = {
    async readShared() { return state; },
    async writeShared(expected, next) {
      const apply = () => {
        if (state !== expected) throw new Error("changed");
        state = next;
      };
      if (persistHook) await persistHook(apply);
      else apply();
    },
    async readDevice() { return structuredClone(local); },
    async writeDevice(next) { local = structuredClone(next); },
  };
  let beforeWrite: (() => Promise<void>) | undefined;
  const dirty = new Set<string>();
  const files: StudyVault = {
    markdownFiles: () => [...paths],
    folderExists: (path) => existsSync(join(root, path)),
    read: (path) => readFile(join(root, path), "utf8"),
    async process(path, edit) {
      const hook = beforeWrite;
      beforeWrite = undefined;
      await hook?.();
      const previous = await this.read(path);
      const next = edit(previous);
      if (next !== previous) await writeFile(join(root, path), next);
    },
    hasUnsavedChanges: (path) => dirty.has(path),
    async create(path, source) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source, { flag: "wx" });
      paths.add(path);
    },
    async trash(path, validate) {
      validate(await this.read(path));
      await rm(join(root, path));
      paths.delete(path);
    },
  };
  return {
    files,
    open: async () => new StudyCards(files, await StudyStorage.open(io, null, randomUUID), randomUUID),
    beforePersist: (hook?: typeof persistHook) => { persistHook = hook; },
    hook: (fn: () => Promise<void>) => { beforeWrite = fn; },
    dirty,
    edit: (path: string, source: string) => writeFile(join(root, path), source),
    async delete(path: string) {
      await rm(join(root, path));
      paths.delete(path);
    },
    async move(oldPath: string, newPath: string) {
      await mkdir(dirname(join(root, newPath)), { recursive: true });
      await rename(join(root, oldPath), join(root, newPath));
      for (const path of [...paths]) {
        if (path !== oldPath && !path.startsWith(oldPath + "/")) continue;
        paths.delete(path);
        paths.add(newPath + path.slice(oldPath.length));
      }
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("подключает файл, сохраняет оформление и восстанавливает открытый раздел", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  const source = "---\r\ntitle: 'Пример' # сохранить\r\n---\r\nВступление\r\n# Вопрос\r\nОтвет\r\n";
  await vault.files.create("Конспект.md", source);
  let study = await vault.open();
  const section = await study.addSection("История");
  const preview = study.preview(section, [{ kind: "file", path: "Конспект.md" }]);
  const [row] = await preview.refresh();
  assert.deepEqual(row?.cards.map(({ question, answer }) => [question, answer]), [["Вопрос", "Ответ"]]);
  assert.equal(await vault.files.read("Конспект.md"), source);
  assert.deepEqual(await preview.confirm(), { confirmed: true });
  const [card] = study.cards(section);
  assert.ok(card?.id);
  assert.equal(card.status, "new");
  const saved = await vault.files.read("Конспект.md");
  assert.ok(saved.includes("title: 'Пример' # сохранить\r\n"));
  assert.ok(saved.includes("Вступление\r\n# Вопрос\r\nОтвет\r\n"));
  study = await vault.open();
  await study.scan();
  assert.equal(study.activeSection, section);
  assert.equal(study.cards(section)[0]?.id, card.id);
  assert.equal(await vault.files.read("Конспект.md"), saved);
});

test("обновляет предпросмотр папки и сохраняет ручные галочки и исключения", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  const collection = { mode: "collection", level: 2 } as const;
  const marked = "---\nqcards_source: true\n---\n";
  await vault.files.create("Папка/Готово.md", marked + "## Вопрос\nОтвет\n");
  await vault.files.create("Папка/Черновик.md", "## Черновик\n");
  await vault.files.create("Папка/Позже.md", "## Позже\n");
  await vault.files.create("Папка/Вложенная/Тема.md", marked + "## Вложенный вопрос\n");
  const study = await vault.open();
  const section = await study.addSection("Темы");
  const preview = study.preview(section, [{ kind: "folder", path: "Папка", format: collection }]);
  let rows = await preview.refresh();
  assert.deepEqual(Object.fromEntries(rows.map(({ path, checked }) => [path, checked])), {
    "Папка/Готово.md": true, "Папка/Черновик.md": false, "Папка/Позже.md": false,
  });
  preview.choose(0, "Папка/Готово.md", { checked: false });
  preview.choose(0, "Папка/Черновик.md", { checked: true });
  await vault.move("Папка/Черновик.md", "Папка/Переименован.md");
  preview.rename("Папка/Черновик.md", "Папка/Переименован.md");
  await vault.edit("Папка/Переименован.md", "## Первый\nОтвет\n### Уточнение\nПример\n\n## Второй\n\n~~~md\n## В коде\n~~~\n\n# Другая тема\nВне ответа");
  await vault.files.create("Папка/Новый.md", marked + "## Новый\n");
  await vault.files.create("Папка/Временный.md", marked + "## Временный\n");
  assert.ok((await preview.refresh()).some(({ path }) => path === "Папка/Временный.md"));
  await vault.delete("Папка/Временный.md");
  rows = await preview.refresh();
  const manual = rows.find(({ path }) => path === "Папка/Переименован.md");
  assert.equal(manual?.checked, true);
  assert.deepEqual(manual.cards.map(({ question, answer }) => [question, answer]), [
    ["Первый", "Ответ\n### Уточнение\nПример"],
    ["Второй", "~~~md\n## В коде\n~~~"],
  ]);
  assert.ok(!rows.some(({ path }) => path.includes("Временный")));
  assert.deepEqual(await preview.confirm(), { confirmed: true });
  assert.deepEqual(study.cards(section).map(({ question }) => question).sort(), ["Второй", "Новый", "Первый"].sort());

  await vault.edit("Папка/Позже.md", marked + "## Позже\n");
  await study.update("Папка/Позже.md");
  await vault.files.create("Папка/Авто.md", marked + "## Авто\n");
  await study.update("Папка/Авто.md");
  await vault.files.create("Папка/Обычная.md", "## Обычная\n");
  await study.update("Папка/Обычная.md");
  const automatic = study.cards(section).find(({ question }) => question === "Авто");
  assert.ok(automatic?.id);
  assert.ok(study.cards(section).find(({ question }) => question === "Позже")?.id);
  assert.ok(!study.cards(section).some(({ question }) => question === "Обычная" || question === "Вопрос"));

  await vault.move("Папка", "Курс");
  await study.rename("Папка", "Курс");
  assert.equal(study.sections[0]?.sources[0]?.path, "Курс");
  assert.equal(study.cards(section).find(({ question }) => question === "Авто")?.id, automatic.id);
  assert.ok(!study.cards(section).some(({ question }) => question === "Вопрос"));
  const recursive = study.preview(section, [{ kind: "folder", path: "Курс", recursive: true, format: collection }]);
  await recursive.refresh();
  await vault.edit("Курс/Обычная.md", "## Отредактированный черновик\n");
  assert.deepEqual(await recursive.confirm(), { confirmed: true });
  assert.ok(study.cards(section).some(({ question }) => question === "Вложенный вопрос"));
});

test("сохраняет исключение при переименовании файла и изменении списка источников", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  const excluded = "# Черновик\nОтвет\n";
  await vault.files.create("Черновик.md", excluded);
  await vault.files.create("Вопрос.md", "# Вопрос\nОтвет\n");
  const study = await vault.open();
  const section = await study.addSection("Курс");
  const preview = study.preview(section, [{ kind: "file", path: "Черновик.md" }]);
  await preview.refresh();
  preview.choose(0, "Черновик.md", { checked: false });
  await vault.move("Черновик.md", "Пропустить.md");
  preview.rename("Черновик.md", "Пропустить.md");
  preview.replaceSources([{ kind: "file", path: "Вопрос.md" }, ...preview.sources]);

  const rows = await preview.refresh();
  assert.equal(rows.find(({ path }) => path === "Пропустить.md")?.checked, false);
  assert.deepEqual(await preview.confirm(), { confirmed: true });
  assert.equal(await vault.files.read("Пропустить.md"), excluded);
  assert.deepEqual(study.cards(section).map(({ question }) => question), ["Вопрос"]);
});

test("запрашивает повторное подтверждение после изменения файла во время записи и ждёт редактор", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  await vault.files.create("Тема.md", "# Старый вопрос\nСтарый ответ\n");
  const study = await vault.open();
  const section = await study.addSection("Курс");
  const preview = study.preview(section, [{ kind: "file", path: "Тема.md" }]);
  await preview.refresh();
  const edited = "# Новый вопрос\nНовый ответ\n";
  vault.hook(() => vault.edit("Тема.md", edited));
  assert.deepEqual(await preview.confirm(), { confirmed: false, paths: ["Тема.md"] });
  assert.equal(await vault.files.read("Тема.md"), edited);
  assert.equal(study.cards(section).length, 0);
  assert.equal((await preview.refresh())[0]?.cards[0]?.question, "Новый вопрос");
  vault.dirty.add("Тема.md");
  assert.deepEqual(await preview.confirm(), { confirmed: false, paths: ["Тема.md"] });
  assert.equal(await vault.files.read("Тема.md"), edited);
  vault.dirty.clear();
  await preview.refresh();
  assert.deepEqual(await preview.confirm(), { confirmed: true });
  assert.equal(study.cards(section)[0]?.answer, "Новый ответ");
});

test("показывает выбор формата при пересечении и использует один формат во всех разделах", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  await vault.files.create("Корень/Темы/Вопросы.md", "---\nqcards_source: true\n---\n# Введение\n## Один\nА\n## Два\nБ");
  const study = await vault.open();
  const section = await study.addSection("Курс");
  const collection = { mode: "collection", level: 2 } as const;
  const sources = [
    { kind: "folder", path: "Корень", recursive: true },
    { kind: "folder", path: "Корень/Темы", format: collection },
  ] as const;
  const preview = study.preview(section, [...sources]);
  assert.ok((await preview.refresh()).every(({ needsFormat }) => needsFormat));
  assert.deepEqual(await preview.confirm(), { confirmed: false, paths: ["Корень/Темы/Вопросы.md"] });
  preview.choose(1, "Корень/Темы/Вопросы.md", { format: collection });
  await preview.refresh();
  assert.deepEqual(await preview.confirm(), { confirmed: true });
  assert.deepEqual(study.cards(section).map(({ question }) => question), ["Один", "Два"]);

  const other = await study.addSection("Общие темы");
  const again = study.preview(other, [{ kind: "file", path: "Корень/Темы/Вопросы.md" }]);
  assert.deepEqual((await again.refresh())[0]?.format, collection);
  assert.deepEqual(await again.confirm(), { confirmed: true });
  assert.deepEqual(study.cards(other).map(({ id }) => id), study.cards(section).map(({ id }) => id));
});

test("создаёт заметки с шаблоном и без него и выделяет заголовки H1–H6", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  const study = await vault.open();
  const section = await study.addSection("Заметки");
  const blank = await study.createCard(section, "Пустая", "Курс", { mode: "single", question: "filename" }, false);
  const original = study.cards(section)[0]!;
  assert.equal(original.question, "Пустая");
  assert.ok(original.id);
  assert.equal(original.answer, "");
  await vault.edit(blank, (await vault.files.read(blank)) + "# Другой вопрос\nОтвет");
  await study.update(blank);
  assert.equal(study.cards(section)[0]?.question, "Пустая");
  assert.equal(study.cards(section)[0]?.answer, "# Другой вопрос\nОтвет");
  const paths = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    study.createCard(section, "Коллекция " + index, "Курс", { mode: "collection", level: index + 1 }, true)));
  for (const path of paths) {
    const card = study.cards(section).find((card) => card.path === path);
    assert.equal(card?.question, "Вопрос");
    assert.equal(card.answer, "Ответ");
    assert.ok(card.id);
  }
  const empty = await study.createCard(section, "Пустая коллекция", "Курс", { mode: "collection", level: 2 }, false);
  const props = await vault.files.read(empty);
  assert.ok(!study.cards(section).some(({ path }) => path === empty));
  await vault.edit(empty, props + "Тема\n\nВопрос\n------\nОтвет");
  await study.update(empty);
  assert.equal(study.cards(section).find(({ path }) => path === empty)?.question, "Вопрос");
  assert.ok(study.cards(section).find(({ path }) => path === empty)?.id);
  await assert.rejects(study.createCard(section, "Пустая", "Курс", { mode: "single", question: "heading" }, true));
  assert.equal(study.cards(section).filter(({ path }) => path === blank).length, 1);
});

test("сохраняет историю при переименовании, отключении, удалении и возврате UUID", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  let study = await vault.open();
  const first = await study.addSection("Первая тема");
  const path = await study.createCard(first, "Вопрос", "", { mode: "single", question: "heading" }, true);
  const card = study.cards(first)[0]!;
  const progress = { history: [{ score: 1 }], schedule: { next: "2026-12-01" } };
  await study.saveProgress(card, progress);
  const second = await study.addSection("Вторая тема");
  const preview = study.preview(second, [{ kind: "file", path }]);
  await preview.refresh();
  await preview.confirm();
  assert.deepEqual(study.cards(second)[0]?.progress, progress);
  const newPath = "Подпапка/Перемещён.md";
  await vault.move(path, newPath);
  await study.rename(path, newPath);
  const saved = (await vault.files.read(newPath)).replace("# Вопрос", "# Другая формулировка");
  await vault.edit(newPath, saved);
  await study.update(newPath);
  assert.equal(study.cards(first)[0]?.id, card.id);
  assert.equal(study.cards(second)[0]?.question, "Другая формулировка");
  await study.removeSource(first, study.sections.find(({ id }) => id === first)!.sources[0]!.id);
  assert.equal(study.cards(first).length, 0);
  await vault.delete(newPath);
  await study.delete(newPath);
  assert.equal(study.cards(second).length, 0);
  await vault.files.create(newPath, saved);
  study = await vault.open();
  await study.scan();
  assert.equal(study.cards(second)[0]?.id, card.id);
  assert.deepEqual(study.cards(second)[0]?.progress, progress);
});

test("блокирует спорную историю и разрешает конфликты UUID в файлах и секциях", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  const study = await vault.open();
  const section = await study.addSection("Материалы");
  const path = await study.createCard(section, "Оригинал", "", { mode: "single", question: "filename" }, false);
  let original = study.cards(section)[0]!;
  const history = { history: [1] };
  await study.saveProgress(original, history);
  const source = await vault.files.read(path);
  await vault.files.create("Копия.md", source);
  await vault.files.create("Лишняя.md", source);
  const preview = study.preview(section, [
    { kind: "file", path: "Копия.md" }, { kind: "file", path: "Лишняя.md" },
  ]);
  await preview.refresh();
  await preview.confirm();
  assert.equal(study.duplicates(original.id!).length, 3);
  original = study.cards(section).find((card) => card.path === path)!;
  await assert.rejects(study.saveProgress(original, { history: [2] }), /Исправьте/);
  assert.equal(original.progress, undefined);
  await study.resolveDuplicate(original, study.cards(section).find(({ path }) => path === "Копия.md")!, "new-id");
  await study.resolveDuplicate(original, study.cards(section).find(({ path }) => path === "Лишняя.md")!, "trash");
  assert.deepEqual(study.cards(section).find((card) => card.path === path)?.progress, history);
  assert.notEqual(study.cards(section).find(({ path }) => path === "Копия.md")?.id, original.id);
  assert.ok(!vault.files.markdownFiles().includes("Лишняя.md"));

  const collection = await study.createCard(section, "Коллекция", "", { mode: "collection", level: 2 }, false);
  const newSource = await vault.files.read(collection);
  await vault.edit(collection, newSource + "## Один\n<!-- qcards:id=" + original.id + " -->\nОтвет\n\n"
    + "## Два\n<!-- qcards:id=" + original.id + " -->\nДругой ответ");
  await study.update(collection);
  const first = study.cards(section).find(({ question }) => question === "Один")!;
  const second = study.cards(section).find(({ question }) => question === "Два")!;
  await assert.rejects(study.resolveDuplicate(first, second, "trash"), /В коллекции/);
  await study.resolveDuplicate(original, first, "new-id");
  assert.equal(study.cards(section).find(({ question }) => question === "Два")?.id, original.id);
  await study.resolveDuplicate(original, second, "new-id");
  assert.deepEqual(study.cards(section).find((card) => card.path === path)?.progress, history);
});

test("показывает пропавший UUID после перезапуска и возвращает историю при восстановлении ID", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  let study = await vault.open();
  const section = await study.addSection("Коллекции");
  const path = await study.createCard(section, "Темы", "", { mode: "collection", level: 2 }, true);
  const card = study.cards(section)[0]!;
  const original = await vault.files.read(path);
  await study.saveProgress(card, { history: [1] });
  await vault.edit(path, original.replace(/<!-- qcards:id=.* -->\n/, "")
    .replace("## Вопрос", "## Уточнённый вопрос").replace("Ответ", "Переписанный ответ"));
  study = await vault.open();
  await study.scan();
  let missing = study.cards(section)[0]!;
  assert.equal(missing.identity, "missing");
  assert.equal(missing.id, null);
  await study.repairId(missing);
  assert.notEqual(study.cards(section)[0]?.id, card.id);
  assert.equal(study.cards(section)[0]?.progress, undefined);
  await vault.edit(path, original.replace(card.id!, "ошибка"));
  await study.update(path);
  missing = study.cards(section)[0]!;
  assert.equal(missing.identity, "invalid");
  await assert.rejects(study.saveProgress(missing, { history: [2] }), /Исправьте/);
  await vault.edit(path, original);
  await study.update(path);
  assert.deepEqual(study.cards(section)[0]?.progress, { history: [1] });
});

test("исправляет статус и сохраняет тематические теги, оформление списка и расписание", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  const study = await vault.open();
  const section = await study.addSection("Статусы");
  const path = await study.createCard(section, "Одна", "", { mode: "single", question: "heading" }, false);
  const card = study.cards(section)[0]!;
  const progress = { history: [2], schedule: { due: 15 } };
  await study.saveProgress(card, progress);
  const withTags = (await vault.files.read(path)).replace(/---\n$/, "tags:\n  - 'тематика' # оставить комментарий\n"
    + "  - qcards/status/studied\n  - qcards/status/unknown\ncustom: 'не менять'\n---\n");
  await vault.edit(path, withTags + "# Заголовок\n\nОтвет #qcards/status/mastered\n");
  await study.update(path);
  let current = study.cards(section)[0]!;
  assert.equal(current.status, "invalid");
  await assert.rejects(study.saveProgress(current, { history: [0] }), /Исправьте/);
  await study.setStatus(current, "mastered");
  current = study.cards(section)[0]!;
  assert.equal(current.status, "mastered");
  assert.deepEqual(current.progress, progress);
  const saved = await vault.files.read(path);
  assert.ok(saved.includes("  - 'тематика' # оставить комментарий\n"));
  assert.ok(saved.includes("custom: 'не менять'\n"));
  assert.ok(saved.includes("Ответ #qcards/status/mastered\n"));
  await study.setStatus(current, "studied");
  assert.equal(study.cards(section)[0]?.status, "studied");
  await study.setStatus(study.cards(section)[0]!, "new");
  assert.equal(study.cards(section)[0]?.status, "new");
});

test("читает статус каждой секции и сохраняет её Markdown за пределами служебной строки", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  const study = await vault.open();
  const section = await study.addSection("Секции");
  const path = await study.createCard(section, "Коллекция", "", { mode: "collection", level: 2 }, false);
  const props = await vault.files.read(path);
  await vault.edit(path, props + "## Один\n#тема #qcards/status/new #qcards/status/studied\n\n"
    + "Ответ с `#qcards/status/mastered`\n\n## Два\n\n~~~\n#qcards/status/mastered\n~~~\n");
  await study.update(path);
  const [first, second] = study.cards(section);
  assert.equal(first?.status, "invalid");
  assert.equal(second?.status, "new");
  assert.equal(first.answer, "#тема\n\nОтвет с `#qcards/status/mastered`");
  assert.equal(second.answer, "~~~\n#qcards/status/mastered\n~~~");
  await study.setStatus(first, "mastered");
  assert.equal(study.cards(section)[0]?.status, "mastered");
  assert.equal(study.cards(section)[1]?.status, "new");
  assert.ok((await vault.files.read(path)).includes("#тема #qcards/status/mastered"));
});

test("сохраняет индентированный код в ответе и при смене статуса", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  const study = await vault.open();
  const section = await study.addSection("Код");
  const path = await study.createCard(section, "Коллекция", "", { mode: "collection", level: 2 }, false);
  const code = "    #qcards/status/studied\n    kept as code";
  await vault.edit(path, (await vault.files.read(path)) + "## Вопрос\n\n" + code + "\n");
  await study.update(path);
  const [card] = study.cards(section);
  assert.equal(card?.status, "new");
  assert.equal(card.answer, code);
  await study.setStatus(card, "mastered");
  assert.equal(study.cards(section)[0]?.answer, code);
  assert.equal(study.cards(section)[0]?.status, "mastered");
  assert.ok((await vault.files.read(path)).includes(code));

  const source = await vault.files.read(path);
  await vault.edit(path, source.replace(/#qcards\/status\/mastered\n\n+/, ""));
  await study.update(path);
  const adjacent = study.cards(section)[0]!;
  assert.equal(adjacent.answer, code);
  await study.setStatus(adjacent, "studied");
  assert.ok((await vault.files.read(path)).includes("#qcards/status/studied\n\n" + code));
});

test("вставляет свойства перед концом YAML-документа и сохраняет переставленные UUID", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  const study = await vault.open();
  const section = await study.addSection("Темы");
  const path = "Конспект.md";
  const first = "## Первый\nПервый ответ\n";
  const second = "## Второй\nВторой ответ\n";
  await vault.files.create(path, "---\ntitle: 'Конспект' # оставить\n... # конец YAML\n---\n" + first + "\n" + second);
  const preview = study.preview(section, [{ kind: "file", path, format: { mode: "collection", level: 2 } }]);
  await preview.refresh();
  assert.deepEqual(await preview.confirm(), { confirmed: true });
  const [firstCard, secondCard] = study.cards(section);
  assert.ok(firstCard?.id);
  assert.ok(secondCard?.id);
  await study.saveProgress(firstCard, { history: [1] });
  const content = await vault.files.read(path);
  assert.ok(content.includes("title: 'Конспект' # оставить\n"));
  const [props, firstSection, secondSection] = content.split(/(?=^## )/m) as [string, string, string];
  assert.ok(props.endsWith("... # конец YAML\n---\n"));
  await vault.edit(path, props + secondSection + "\n" + firstSection.replace("## Первый", "## Уточнённый"));
  await study.update(path);
  const [a, b] = study.cards(section);
  assert.equal(a?.id, secondCard.id);
  assert.equal(b?.id, firstCard.id);
  assert.equal(b.question, "Уточнённый");
  assert.deepEqual(b.progress?.history, [1]);
});

test("обнаруживает потерю UUID при перестановке и полном переписывании вопроса", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  const study = await vault.open();
  const section = await study.addSection("Темы");
  const path = await study.createCard(section, "Коллекция", "", { mode: "collection", level: 2 }, false);
  const props = await vault.files.read(path);
  await vault.edit(path, props + "## Первый\nОтвет 1\n\n## Второй\nОтвет 2\n\n## Третий\nОтвет 3\n");
  await study.update(path);
  const middle = study.cards(section)[1]!;
  const history = { history: [1] };
  await study.saveProgress(middle, history);
  const [, first, second, third] = (await vault.files.read(path)).split(/(?=^## )/m) as [string, string, string, string];
  await vault.edit(path, props + third + "\n## Переписан\nСовершенно новый текст\n\n" + first);
  await study.update(path);
  const card = study.cards(section)[1]!;
  assert.equal(card.question, "Переписан");
  assert.equal(card.identity, "missing");
  assert.equal(card.id, null);
  await vault.edit(path, props + third + "\n" + second + first);
  await study.update(path);
  assert.deepEqual(study.cards(section)[1]?.progress, history);
});

test("интервальная оценка и срок сохраняются вместе, повтор не создаёт дубль, отмена возвращает срок", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  let study = await vault.open();
  const sectionId = await study.addSection("Интервалы");
  await study.createCard(sectionId, "Вопрос", "", { mode: "single", question: "filename" }, false);
  await study.setStatus(study.cards(sectionId)[0]!, "studied");
  const selected = study.cards(sectionId)[0]!;
  const uuid = selected.id!;
  const sessionId = randomUUID();
  const review = { sectionId, sessionId, at: "2026-11-21T10:00:00Z", grade: "good" as const };
  const intent = { id: randomUUID(), revision: study.progress.revision };

  vault.beforePersist(() => {
    assert.equal(study.persistence.saving, true);
    assert.equal(study.progress.progress[uuid], undefined);
    throw new Error("disk full");
  });
  await assert.rejects(study.recordReview(intent, selected, review, { dueAt: "2026-11-22T10:00:00Z" }), /Повторите действие/);
  assert.equal(study.progress.progress[uuid], undefined);
  study = await vault.open();
  await study.scan();
  assert.equal(study.progress.progress[uuid], undefined);

  vault.beforePersist((apply) => { apply(); throw new Error("response lost"); });
  const first = study.cards(sectionId)[0]!;
  await Promise.all([
    study.recordReview(intent, first, review, { dueAt: "2026-11-22T10:00:00Z" }),
    study.recordReview(intent, first, review, { dueAt: "2026-11-22T10:00:00Z" }),
  ]);
  vault.beforePersist();
  study = await vault.open();
  await study.scan();
  await study.recordReview(intent, first, review, { dueAt: "2026-11-22T10:00:00Z" });
  assert.deepEqual(study.progress.progress[uuid]?.reviews?.map(({ id }) => id), [intent.id]);
  assert.deepEqual(study.progress.progress[uuid]?.schedule, { dueAt: "2026-11-22T10:00:00Z" });

  const second = { id: randomUUID(), revision: study.progress.revision };
  await study.recordReview(second, study.cards(sectionId)[0]!, { ...review, at: "2026-11-22T10:00:00Z" }, { dueAt: "2026-11-28T10:00:00Z" });
  assert.equal(study.progress.progress[uuid]?.reviews?.length, 2);
  await study.undoReview({ id: randomUUID(), revision: study.progress.revision }, uuid, sessionId, second.id);
  assert.deepEqual(study.progress.progress[uuid]?.reviews?.map(({ id }) => id), [intent.id]);
  assert.deepEqual(study.cards(sectionId)[0]?.progress?.schedule, { dueAt: "2026-11-22T10:00:00Z" });
});

test("свободная проверка сохраняет исправленную оценку, порядок и позицию недоступного вопроса", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  let study = await vault.open();
  const sectionId = await study.addSection("Свободная проверка");
  const oldPath = await study.createCard(sectionId, "Первый", "", { mode: "single", question: "filename" }, false);
  await study.createCard(sectionId, "Второй", "", { mode: "single", question: "filename" }, false);
  const first = study.cards(sectionId).find(({ path }) => path === oldPath)!.id!;
  const second = study.cards(sectionId).find(({ path }) => path === "Второй.md")!.id!;
  const mutation = () => ({ id: randomUUID(), revision: study.progress.revision });
  const startedAt = "2026-11-21T10:00:00Z";
  const session = { id: randomUUID(), sectionId, startedAt, retryOf: null, cardIds: [first, second], position: 0,
    grades: { [first]: "correct" as const } };
  await study.saveFreeCheck(mutation(), session);
  await study.saveFreeCheck(mutation(), { ...session, position: 1, grades: { [first]: "incorrect" } });
  const saved = await vault.files.read(oldPath);
  const source = study.sections[0]!.sources.find(({ path }) => path === oldPath)!;
  await vault.delete(oldPath);
  study = await vault.open();
  await study.scan();
  assert.equal(study.progress.freeSession?.position, 1);
  assert.deepEqual(study.freeCheckQuestions().map(({ id, card, grade }) => [id, card?.path ?? null, grade]),
    [[first, null, "incorrect"], [second, "Второй.md", null]]);
  assert.deepEqual(study.missingSources(sectionId).map(({ id }) => id), [source.id]);
  await study.saveFreeCheck(mutation(), { ...session, position: 0, grades: {} });
  assert.equal(study.freeCheckQuestions()[0]?.grade, "incorrect");

  const newPath = "Перенос/Первый.md";
  await vault.files.create(newPath, saved);
  const reconnect = study.preview(sectionId, [{ kind: "file", path: newPath, format: source.format }], source.id);
  await reconnect.refresh();
  assert.deepEqual(await reconnect.confirm(), { confirmed: true });
  assert.equal(study.freeCheckQuestions()[0]?.card?.id, first);
  assert.equal(study.freeCheckQuestions()[0]?.card?.path, newPath);
  assert.equal(study.freeCheckQuestions()[0]?.grade, "incorrect");
  assert.equal(study.missingSources(sectionId).length, 0);

  const finish = mutation();
  const finishedAt = "2026-11-21T11:00:00Z";
  vault.beforePersist(() => { throw new Error("disk full"); });
  await assert.rejects(study.finishFreeCheck(finish, session.id, finishedAt), /Повторите действие/);
  assert.equal(study.progress.freeResults.length, 0);
  assert.equal(study.progress.freeSession?.id, session.id);
  vault.beforePersist((apply) => { apply(); throw new Error("response lost"); });
  await study.finishFreeCheck(finish, session.id, finishedAt);
  study = await vault.open();
  await study.scan();
  await study.finishFreeCheck(finish, session.id, finishedAt);
  assert.equal(study.progress.freeSession, null);
  assert.equal(study.progress.freeResults.length, 1);

  vault.beforePersist();
  const retry = { id: randomUUID(), sectionId, startedAt: finishedAt, retryOf: session.id, cardIds: [first], position: 0, grades: {} };
  await study.setStatus(study.cards(sectionId).find(({ id }) => id === first)!, "studied");
  const retryCard = study.cards(sectionId).find(({ id }) => id === first)!;
  await study.recordReview(mutation(), retryCard,
    { sectionId, sessionId: randomUUID(), at: finishedAt, grade: "hard" }, { dueAt: "2026-11-24T11:00:00Z" });
  await study.setSuspended(mutation(), retryCard, true);
  await study.saveFreeCheck(mutation(), retry);
  const beforeExport = study.progress;
  const exported = await study.exportStudyData();
  await study.addSection("Новые данные");
  const preview = await study.previewImport(exported);
  assert.equal(preview.incoming.intervalReviews, 1);
  assert.equal(preview.incoming.freeResults, 1);
  assert.equal(preview.incoming.pendingCheck?.retry, true);
  await study.importStudyData(preview);
  assert.deepEqual(study.progress.progress, beforeExport.progress);
  assert.deepEqual(study.progress.freeResults, beforeExport.freeResults);
  assert.deepEqual(study.progress.freeSession, beforeExport.freeSession);
  study = await vault.open();
  await study.scan();
  assert.equal(study.progress.freeSession?.retryOf, session.id);
  await study.finishFreeCheck(mutation(), retry.id, finishedAt);
  assert.equal(study.progress.freeResults.length, 1);
  await study.saveFreeCheck(mutation(), { ...retry, id: randomUUID() });
  await study.discardFreeCheck(mutation(), study.progress.freeSession!.id);
  assert.equal(study.progress.freeSession, null);
  assert.equal(study.progress.freeResults.length, 1);
});
