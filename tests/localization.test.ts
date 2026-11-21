import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalization } from "../src/localization";
import { messages } from "../src/messages";

test("the command name follows Obsidian's interface language and falls back to English", () => {
  for (const language of ["en", "en-GB", "fr", "", undefined, "unknown"]) {
    assert.equal(createLocalization(language).text("openStudyCards"), "Open Study Cards");
  }
  assert.equal(createLocalization("ru").text("openStudyCards"), "Открыть Study Cards");
});

test("formats complete messages, including Russian question plurals and literal names", () => {
  const russian = createLocalization("ru");
  const english = createLocalization("fr");
  for (const [count, expected] of [
    [0, "Доступно 0 вопросов"], [1, "Доступен 1 вопрос"], [2, "Доступно 2 вопроса"],
    [5, "Доступно 5 вопросов"], [11, "Доступно 11 вопросов"], [21, "Доступен 21 вопрос"],
  ] as const) assert.equal(russian.text("questionsAvailable", { count }), expected);
  assert.equal(english.text("questionsAvailable", { count: 1 }), "1 question available");
  assert.equal(english.text("questionsAvailable", { count: 2 }), "2 questions available");
  assert.equal(english.text("openNoteNamed", { path: "Курс/{count}.md" }), "Open note Курс/{count}.md");
  assert.equal(english.text("sourceWithSubfolders", { path: "文档/Курс" }), "文档/Курс · includes subfolders");
});

test("formats numbers, percentages, dates and review intervals in the plugin language", () => {
  const english = createLocalization("fr", "UTC");
  const russian = createLocalization("ru", "UTC");
  const date = "2026-11-21T13:04:05Z";
  assert.equal(english.date(date), "11/21/2026, 1:04:05 PM");
  assert.equal(russian.date(date), "21.11.2026, 13:04:05");
  assert.equal(english.text("questionsAvailable", { count: 1234 }), "1,234 questions available");
  assert.equal(english.percent(0.375), "37.5%");
  assert.equal(russian.percent(0.375), "37,5 %");
  assert.equal(english.interval(60_000), "1 min");
  assert.equal(english.interval(90 * 60_000), "1.5 hr");
  assert.equal(russian.interval(90 * 60_000), "1,5 ч");
  assert.equal(russian.interval(36 * 3_600_000), "1,5 дн");
});

test("both catalogs provide every message and agree on its placeholders", () => {
  for (const [key, [english, russian]] of Object.entries(messages)) {
    assert.equal(typeof english, typeof russian, key);
    const templates = [english, russian].flatMap((message) =>
      typeof message === "string" ? [message] : Object.values(message));
    const placeholders = (text: string) => [...new Set(text.match(/\{\w+\}/g))].sort();
    const expected = placeholders(templates[0]!);
    for (const template of templates) {
      assert.ok(template.trim(), key);
      assert.deepEqual(placeholders(template), expected, key);
    }
    if (typeof english !== "string" && typeof russian !== "string") {
      assert.deepEqual(Object.keys(english).sort(), ["one", "other"], key);
      assert.deepEqual(Object.keys(russian).sort(), ["few", "many", "one", "other"], key);
    }
  }
});

test("displayed dates follow the device time zone even if it changes after startup", (t) => {
  const previous = process.env.TZ;
  t.after(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });
  process.env.TZ = "UTC";
  const english = createLocalization("en");
  const timestamp = "2026-11-21T13:04:05Z";
  assert.equal(english.date(timestamp), "11/21/2026, 1:04:05 PM");
  process.env.TZ = "Europe/Samara";
  assert.equal(english.date(timestamp), "11/21/2026, 5:04:05 PM");
});
