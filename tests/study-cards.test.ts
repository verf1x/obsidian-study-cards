import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { IntervalSession } from "../src/interval-session";
import { setInterfaceLanguage } from "../src/localization";
import { StudyCards, type StudyVault } from "../src/study-cards";

import { SharedWriteNotApplied, StudyStorage, type StudyStorageIO } from "../src/study-storage";

setInterfaceLanguage("ru");

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
        if (state !== expected) throw new SharedWriteNotApplied("changed");
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
  const unreadable = new Set<string>();
  const files: StudyVault = {
    markdownFiles: () => [...paths],
    folderExists: (path) => existsSync(join(root, path)),
    async read(path) {
      if (unreadable.has(path)) throw new Error("EIO");
      return readFile(join(root, path), "utf8");
    },
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
    unreadable,
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

test("a connected collection keeps its selected questions after reopening", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  const path = "Notes/Questions.md";
  await vault.files.create(path, Array.from({ length: 50 }, (_, index) =>
    `## Question ${index + 1}\nAnswer ${index + 1}\n`).join("\n"));
  let study = await vault.open();
  const section = await study.addSection("Topic");
  const enrollment = study.preview(section, [{ kind: "file", path, format: { mode: "collection", level: 2 } }]);
  await enrollment.refresh();
  assert.deepEqual(await enrollment.confirm(), { confirmed: true });
  assert.equal(study.cards(section).length, 50);

  const settings = study.noteQuestions(section, path)!;
  assert.equal(settings.cardIds, null);
  const selected = settings.cards.slice(0, 12).map(({ id }) => id!);
  const markdown = await vault.files.read(path);
  await study.setNoteQuestions(section, path, { selectedCardIds: selected, expectedCardIds: settings.cardIds });
  assert.equal(await vault.files.read(path), markdown);

  study = await vault.open();
  await study.scan();
  assert.deepEqual(study.cards(section, "source").map(({ id }) => id), selected);
  assert.deepEqual(new Set(study.noteQuestions(section, path)?.cardIds), new Set(selected));
  assert.equal(study.noteQuestions(section, path)?.cards.length, 50);
});

test("question selection applies across overlapping sources and study modes within each section", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  const path = "Notes/Questions.md";
  const format = { mode: "collection", level: 2 } as const;
  await vault.files.create(path, "## First\nFirst answer\n\n## Second\nSecond answer\n");
  const study = await vault.open();
  const topic = await study.addSection("Topic");
  const other = await study.addSection("Other");
  const direct = study.preview(topic, [{ kind: "file", path, format }]);
  await direct.refresh();
  assert.deepEqual(await direct.confirm(), { confirmed: true });
  for (const section of [topic, other]) {
    const folder = study.preview(section, [{ kind: "folder", path: "Notes", format }]);
    await folder.refresh();
    assert.deepEqual(await folder.confirm(), { confirmed: true });
  }
  for (const card of study.cards(topic)) await study.setStatus(card, "studied");
  const [first, second] = study.cards(topic, "source").map(({ id }) => id!);
  assert.ok(first && second);
  await study.setNoteQuestions(topic, path, { selectedCardIds: [first], expectedCardIds: null });
  assert.deepEqual(study.cards(topic).map(({ id }) => id), [first]);
  assert.deepEqual(study.cards(other).map(({ id }) => id), [first, second]);
  assert.deepEqual(study.intervalCards(topic).map(({ id }) => id), [first]);
  assert.deepEqual(study.intervalCards(null).map(({ id }) => id), [first, second]);
  await study.setNoteQuestions(other, path, { selectedCardIds: [], expectedCardIds: null });
  assert.deepEqual(study.intervalCards(null).map(({ id }) => id), [first]);

  const mutation = () => ({ id: randomUUID(), revision: study.progressRevision });
  const started = mutation();
  const startedAt = "2026-11-21T10:00:00.000Z";
  await study.startFreeCheck(started, null, { sectionId: topic, count: 1, order: "standard" }, startedAt);
  const question = study.freeCheckQuestions()[0]?.card;
  assert.equal(question?.id, first);
  assert.ok(question);
  await study.gradeFreeCheck(mutation(), started.id, question, "correct");
  await study.setNoteQuestions(topic, path, { selectedCardIds: [], expectedCardIds: [first] });
  assert.deepEqual(study.cards(topic), []);
  assert.equal(study.noteQuestions(topic, path)?.cards.length, 2);
  assert.deepEqual(study.freeCheckQuestions(), [{ id: first, card: null, grade: "correct" }]);
  await assert.rejects(study.gradeFreeCheck(mutation(), started.id, question, "incorrect"));
  await study.setNoteQuestions(topic, path, { selectedCardIds: null, expectedCardIds: [] });
  assert.deepEqual(study.freeCheckQuestions().map(({ card, grade }) => [card?.id, grade]), [[first, "correct"]]);
});

test("a selection follows its note and question IDs while keeping review history", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  const path = "Notes/Questions.md";
  await vault.files.create(path, "## First\nFirst answer\n\n## Second\nSecond answer\n");
  const study = await vault.open();
  const section = await study.addSection("Topic");
  const preview = study.preview(section, [{ kind: "file", path, format: { mode: "collection", level: 2 } }]);
  await preview.refresh();
  assert.deepEqual(await preview.confirm(), { confirmed: true });
  const first = study.cards(section, "source")[0]!;
  await study.setStatus(first, "studied");
  const review = await IntervalSession.start(study, section, () => new Date("2026-11-21T10:00:00.000Z"));
  await review.grade(review.refreshQuestion().question!, "good");
  const progress = study.cards(section, "source")[0]!.progress;
  assert.equal(progress?.reviews?.length, 1);
  assert.ok(progress.schedule);
  await study.setNoteQuestions(section, path, { selectedCardIds: [], expectedCardIds: null });
  assert.deepEqual(study.intervalCards(section), []);
  await study.setNoteQuestions(section, path, { selectedCardIds: [first.id!], expectedCardIds: [] });

  const source = await vault.files.read(path);
  const firstHeading = source.indexOf("## First");
  const secondHeading = source.indexOf("## Second");
  await vault.edit(path, source.slice(0, firstHeading) + source.slice(secondHeading) + "\n"
    + source.slice(firstHeading, secondHeading).replace("## First", "## Renamed") + "\n## New\nNew answer\n");
  await study.update(path);
  assert.deepEqual(study.cards(section).map(({ id, question }) => [id, question]), [[first.id, "Renamed"]]);
  const movedPath = "Moved/Questions.md";
  await vault.move("Notes", "Moved");
  await study.rename("Notes", "Moved");
  assert.deepEqual(study.cards(section).map(({ id, progress }) => [id, progress]), [[first.id, progress]]);
  assert.deepEqual(study.noteQuestions(section, movedPath)?.cardIds, [first.id]);
  await study.setNoteQuestions(section, movedPath, { selectedCardIds: null, expectedCardIds: [first.id!] });
  await vault.edit(movedPath, await vault.files.read(movedPath) + "\n## Another\nAnother answer\n");
  await study.update(movedPath);
  assert.deepEqual(study.cards(section, "source").map(({ question }) => question), ["Second", "Renamed", "New", "Another"]);
});

test("reconnecting a missing source keeps each note's own question selection", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  const oldPath = "First.md";
  const otherPath = "Other.md";
  const movedPath = "Moved.md";
  const format = { mode: "collection", level: 2 } as const;
  await vault.files.create(oldPath, "## First\nFirst answer\n");
  await vault.files.create(otherPath, "## Other\nOther answer\n\n## Extra\nExtra answer\n");
  let study = await vault.open();
  const reconnectToOther = await study.addSection("Reconnect to another note");
  const reconnectToMoved = await study.addSection("Reconnect to the moved note");
  async function connect(section: string, path: string, replaceSourceId?: string) {
    const preview = study.preview(section, [{ kind: "file", path, format }], replaceSourceId);
    await preview.refresh();
    assert.deepEqual(await preview.confirm(), { confirmed: true });
  }
  for (const section of [reconnectToOther, reconnectToMoved]) {
    await connect(section, oldPath);
    await study.setNoteQuestions(section, oldPath, { selectedCardIds: [], expectedCardIds: null });
  }
  await connect(reconnectToOther, otherPath);
  const otherId = study.cards(reconnectToOther, "source")[0]!.id!;
  await study.setNoteQuestions(reconnectToOther, otherPath, { selectedCardIds: [otherId], expectedCardIds: null });
  await vault.move(oldPath, movedPath);

  study = await vault.open();
  await study.scan();
  await connect(reconnectToOther, otherPath, study.missingSources(reconnectToOther)[0]!.id);
  await connect(reconnectToMoved, movedPath, study.missingSources(reconnectToMoved)[0]!.id);
  assert.deepEqual(study.cards(reconnectToOther).map(({ id }) => id), [otherId]);
  assert.deepEqual(study.noteQuestions(reconnectToMoved, movedPath)?.cardIds, []);
  assert.deepEqual(study.cards(reconnectToMoved), []);
});

test("интервальная оценка сохраняет минутный срок и возвращает карточку в сессию", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  let study = await vault.open();
  const section = await study.addSection("Интервалы");
  await study.createCard(section, "Вопрос", "", { mode: "single", question: "filename" }, false);
  await study.setStatus(study.cards(section)[0]!, "mastered");

  let now = new Date("2026-11-21T10:00:00.345Z");
  const clock = () => now;
  let session = await IntervalSession.start(study, section, clock);
  const { question } = session.refreshQuestion();
  assert.ok(question);
  const intervals = session.intervals(question);
  assert.equal(intervals.again, 60_000);
  assert.ok(intervals.good > 10 * 60_000);

  now = new Date("2026-11-21T10:00:05.345Z");
  await session.grade(question, "again");
  const waiting = session.refreshQuestion();
  assert.equal(waiting.question, undefined);
  assert.equal(waiting.nextDue?.toISOString(), "2026-11-21T10:01:05.345Z");

  study = await vault.open();
  await study.scan();
  session = await IntervalSession.start(study, section, clock);
  assert.equal(session.refreshQuestion().nextDue?.toISOString(), "2026-11-21T10:01:05.345Z");
  now = new Date("2026-11-21T10:01:05.344Z");
  assert.equal(session.refreshQuestion().question, undefined);
  now = new Date("2026-11-21T10:01:05.345Z");
  const second = session.refreshQuestion().question;
  assert.equal(second?.card.id, question.card.id);
  assert.equal(second?.card.status, "mastered");
  assert.ok(second && session.intervals(second).good < 60 * 60_000);
});

test("повторная оценка, отмена и статистика учитывают UUID и раздел запуска", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  const study = await vault.open();
  const first = await study.addSection("Первый раздел");
  const second = await study.addSection("Второй раздел");
  const path = await study.createCard(first, "Общий вопрос", "", { mode: "single", question: "filename" }, false);
  const preview = study.preview(second, [{ kind: "file", path }]);
  await preview.refresh();
  await preview.confirm();
  await study.setStatus(study.cards(first)[0]!, "studied");

  let now = new Date(2026, 10, 21, 23, 57);
  const clock = () => now;
  const a = await IntervalSession.start(study, first, clock);
  const q1 = a.refreshQuestion().question!;
  vault.beforePersist(() => { throw new SharedWriteNotApplied("disk full"); });
  await assert.rejects(a.grade(q1, "again"), /Повторите действие/);
  assert.equal(study.intervalStatistics(first, now).reviews, 0);
  vault.beforePersist((apply) => { apply(); throw new Error("response lost"); });
  await Promise.all([a.grade(q1, "again"), a.grade(q1, "again")]);
  vault.beforePersist();
  assert.equal(study.intervalStatistics(first, now).reviews, 1);
  const due = a.refreshQuestion().nextDue!;
  await study.setSuspended({ id: randomUUID(), revision: study.progressRevision }, study.cards(second)[0]!, true);
  assert.equal(a.refreshQuestion().nextDue, undefined);
  assert.equal((await IntervalSession.start(study, second, clock)).refreshQuestion().nextDue, undefined);
  await study.setSuspended({ id: randomUUID(), revision: study.progressRevision }, study.cards(first)[0]!, false);
  assert.deepEqual(a.refreshQuestion().nextDue, due);

  now = due;
  const b = await IntervalSession.start(study, second, clock);
  const q2 = b.refreshQuestion().question!;
  const staleQuestion = a.refreshQuestion().question!;
  const staleUndo = a.refreshQuestion().undo!;
  assert.equal(q2.card.id, q1.card.id);
  await b.grade(q2, "again");
  await assert.rejects(a.grade(staleQuestion, "easy"), /изменились/);
  await assert.rejects(a.undo(staleUndo), /изменились/);
  const dayEndsAt = new Date(2026, 10, 22).getTime();
  assert.deepEqual(study.intervalStatistics(null, now), {
    available: 0, cards: 1, reviews: 2, nextDue: new Date(now.getTime() + 60_000), dayEndsAt,
  });
  assert.equal(study.intervalStatistics(first, now).reviews, 1);
  assert.equal(study.intervalStatistics(second, now).reviews, 1);
  assert.equal(a.refreshQuestion().undo, undefined);
  await b.undo(b.refreshQuestion().undo!);
  assert.equal(b.refreshQuestion().question?.card.id, q1.card.id);
  assert.equal(study.intervalStatistics(second, now).reviews, 0);
  assert.deepEqual(study.intervalStatistics(null, now), { available: 1, cards: 1, reviews: 1, nextDue: undefined, dayEndsAt });
  assert.equal(a.refreshQuestion().undo?.uuid, q1.card.id);

  const copy = await study.createCard(second, "Общий вопрос", "Копии", { mode: "single", question: "filename" }, false);
  const copiedCard = study.cards(second).find((card) => card.path === copy)!;
  assert.notEqual(copiedCard.id, q1.card.id);
  await study.setStatus(copiedCard, "studied");
  const copies = await IntervalSession.start(study, second, clock);
  await copies.grade(copies.refreshQuestion().question!, "easy");
  const copyQuestion = copies.refreshQuestion().question!;
  assert.equal(copyQuestion.card.id, copiedCard.id);
  await copies.grade(copyQuestion, "easy");
  assert.equal(study.intervalStatistics(null, now).cards, 2);

  now = new Date(2026, 10, 22);
  const { available, cards, reviews } = study.intervalStatistics(null, now);
  assert.deepEqual({ available, cards, reviews }, { available: 0, cards: 0, reviews: 0 });
});

test("сессия фиксирует допуск и ставит короткий наступивший шаг перед остальными повторами", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  const study = await vault.open();
  const section = await study.addSection("Очередь");
  const path = "Коллекция.md";
  const markdown = Array.from({ length: 100 }, (_, index) => `## Вопрос ${index + 1}\n\nОтвет ${index + 1}`).join("\n\n");
  await vault.files.create(path, markdown);
  const preview = study.preview(section, [{ kind: "file", path, format: { mode: "collection", level: 2 } }]);
  await preview.refresh();
  await preview.confirm();
  const card = (index: number) => study.cards(section, "source")[index]!;
  for (let index = 0; index < 10; index++) await study.setStatus(card(index), "studied");

  let now = new Date("2026-11-21T10:00:00.000Z");
  const clock = () => now;
  const mutation = () => ({ id: randomUUID(), revision: study.progressRevision });
  for (const [index, dueAt, scheduleStatus] of [
    [1, "2026-11-21T09:00:00.000Z", "review"],
    [2, "2026-11-20T09:00:00.000Z", "review"],
    [3, "2026-11-21T10:00:30.000Z", "learning"],
  ] as const) {
    await study.recordReview(mutation(), card(index), {
      sectionId: section, sessionId: randomUUID(), at: "2026-11-20T08:00:00.000Z", grade: "good",
    }, { dueAt, scheduleStatus });
  }
  assert.equal(study.intervalStatistics(section, now).available, 9);
  const session = await IntervalSession.start(study, section, clock);
  const current = session.refreshQuestion().question!;
  assert.equal(current.card.id, card(2).id);

  now = new Date("2026-11-21T10:00:30.000Z");
  assert.equal(session.refreshQuestion().question?.card.id, current.card.id);
  await session.grade(current, "good");
  const learning = session.refreshQuestion().question!;
  assert.equal(learning.card.id, card(3).id);
  await session.grade(learning, "good");
  assert.equal(session.refreshQuestion().question?.card.id, card(1).id);
  await study.setStatus(card(1), "new");
  assert.equal(session.refreshQuestion().question?.card.id, card(0).id);
  await study.setStatus(card(10), "studied");
  for (const index of [0, 4, 5, 6, 7, 8, 9]) await study.setSuspended(mutation(), card(index), true);
  assert.equal(session.refreshQuestion().question, undefined);
  assert.equal(session.refreshQuestion().available, 0);
  assert.equal(study.intervalStatistics(section, now).available, 1);
  await study.setStatus(card(1), "mastered");
  assert.equal(session.refreshQuestion().question?.card.id, card(1).id);
  assert.equal((study.cards(section, "source")[1]!.progress?.schedule as { dueAt: string }).dueAt,
    "2026-11-21T09:00:00.000Z");

  await vault.delete(path);
  const empty = session.refreshQuestion();
  assert.equal(empty.question, undefined);
  assert.equal(empty.nextDue, undefined);
  await assert.rejects(session.grade(current, "easy"), /изменились/);
  await study.delete(path);
});

test("проверка перед показом пропускает нечитаемый Markdown и подхватывает изменения статуса", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  const study = await vault.open();
  const section = await study.addSection("Источники повторов");
  const format = { mode: "single", question: "filename" } as const;
  const first = await study.createCard(section, "Первый", "", format, false);
  const second = await study.createCard(section, "Второй", "", format, false);
  for (const card of study.cards(section)) await study.setStatus(card, "studied");
  const session = await IntervalSession.start(study, section);

  assert.equal(session.refreshQuestion().question?.card.path, first);
  vault.unreadable.add(first);
  await study.recheckIntervalSource(first);
  assert.equal(session.refreshQuestion().question?.card.path, second);
  assert.equal(study.intervalStatistics(section, new Date()).available, 1);

  const saved = await vault.files.read(second);
  await vault.edit(second, saved.replace("qcards/status/studied", "qcards/status/new"));
  await study.recheckIntervalSource(second);
  assert.equal(session.refreshQuestion().question, undefined);
  vault.unreadable.delete(first);
  const restarted = await IntervalSession.start(study, section);
  assert.equal(restarted.refreshQuestion().question?.card.path, first);
  assert.equal(session.refreshQuestion().question?.card.path, first);
});

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

test("new templates follow the plugin language and old cards keep their Markdown and progress", async (t) => {
  const vault = await testVault();
  t.after(async () => {
    setInterfaceLanguage("ru");
    await vault.cleanup();
  });
  const russian = await vault.open();
  await russian.addSection("Мой раздел");
  const section = russian.activeSection!;
  const single = { mode: "single", question: "heading" } as const;
  const collection = { mode: "collection", level: 2 } as const;
  const existing = await russian.createCard(section, "Первая", "", single, true);
  const russianCollection = await russian.createCard(section, "Коллекция", "", collection, true);
  const card = russian.cards(section).find(({ path }) => path === existing)!;
  await russian.setStatus(card, "studied");
  const original = await vault.files.read(existing);
  assert.ok(original.includes("# Вопрос\n\nОтвет\n"));
  assert.ok((await vault.files.read(russianCollection)).includes("## Вопрос\n"));

  setInterfaceLanguage("fr");
  const english = await vault.open();
  await english.scan();
  const reopened = english.cards(section).find(({ path }) => path === existing)!;
  assert.equal(english.sections[0]!.name, "Мой раздел");
  assert.equal(reopened.id, card.id);
  assert.equal(reopened.status, "studied");
  assert.equal(await vault.files.read(existing), original);
  const newSingle = await english.createCard(section, "Single", "", single, true);
  const newCollection = await english.createCard(section, "Collection", "", collection, true);
  assert.ok((await vault.files.read(newSingle)).includes("# Question\n\nAnswer\n"));
  assert.ok((await vault.files.read(newCollection)).includes("## Question\n"));
  assert.deepEqual(english.cards(section).filter(({ path }) => path === newCollection).map(({ question, answer }) => [question, answer]),
    [["Question", "Answer"]]);
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
    throw new SharedWriteNotApplied("disk full");
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
  vault.beforePersist(() => { throw new SharedWriteNotApplied("disk full"); });
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

test("свободная проверка выбирает вопросы по порядку источников и сохраняет границу открытых вопросов", async (t) => {
  const vault = await testVault();
  t.after(vault.cleanup);
  const collection = { mode: "collection", level: 2 } as const;
  const marked = "---\nqcards_source: true\n---\n";
  const path = "Материалы/B/Коллекция.md";
  await vault.files.create(path, marked + "## Третий\nОтвет\n\n## Четвёртый\nОтвет\n");
  await vault.files.create("Материалы/A/Карточка.md", marked + "# Второй\nОтвет\n");
  await vault.files.create("Явный источник.md", "# Первый\nОтвет\n");
  let study = await vault.open();
  const sectionId = await study.addSection("Раздел");
  const preview = study.preview(sectionId, [
    { kind: "file", path: "Явный источник.md" },
    { kind: "folder", path: "Материалы", recursive: true },
    { kind: "file", path, format: collection },
  ]);
  await preview.refresh();
  preview.choose(1, path, { format: collection });
  await preview.refresh();
  assert.deepEqual(await preview.confirm(), { confirmed: true });
  const mutation = () => ({ id: randomUUID(), revision: study.freeChecks.revision });
  const start = study.cards(sectionId).find(({ question }) => question === "Второй")!.id!;
  const startedAt = "2026-11-21T10:00:00Z";

  const first = mutation();
  await study.startFreeCheck(first, null, { sectionId, start, count: 3, order: "standard" }, startedAt);
  assert.deepEqual(study.freeCheckQuestions().map(({ card }) => card?.question), ["Второй", "Третий", "Четвёртый"]);
  await assert.rejects(study.moveFreeCheck(mutation(), first.id, 1), /Оцените текущий ответ/);
  await assert.rejects(study.startFreeCheck(mutation(), first.id, { sectionId, start, count: 4, order: "standard" }, startedAt),
    /Изменилось количество/);
  assert.equal(study.freeChecks.session?.id, first.id);

  const single = "Материалы/A/Карточка.md";
  const saved = await vault.files.read(single);
  await vault.delete(single);
  await study.delete(single);
  await study.moveFreeCheck(mutation(), first.id, 1);
  await study.moveFreeCheck(mutation(), first.id, -1);
  await vault.files.create(single, saved);
  study = await vault.open();
  await study.scan();
  assert.equal(study.freeCheckQuestions()[0]?.card?.question, "Второй");
  await study.moveFreeCheck(mutation(), first.id, 1);
  assert.equal(study.freeChecks.session?.position, 1);
  await assert.rejects(study.moveFreeCheck(mutation(), first.id, 1), /Оцените текущий ответ/);
  const [restored, current] = study.freeCheckQuestions();
  await assert.rejects(study.gradeFreeCheck(mutation(), first.id, restored!.card!, "correct"), /изменились/);
  await study.gradeFreeCheck(mutation(), first.id, current!.card!, "incorrect");
  await study.gradeFreeCheck(mutation(), first.id, current!.card!, "correct");
  assert.equal(study.freeCheckQuestions()[1]?.grade, "correct");
  await study.moveFreeCheck(mutation(), first.id, 1);
  assert.equal(study.freeChecks.session?.position, 2);
});
