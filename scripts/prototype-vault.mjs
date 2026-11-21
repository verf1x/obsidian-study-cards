import { build } from "esbuild";
import { mkdir, readFile, readdir, writeFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const target = process.argv[2];
if (!target) throw new Error('Usage: npm run prototype -- "path to a new vault"');
const vault = resolve(target);
const marker = ".study-cards-prototype";
await mkdir(vault, { recursive: true });
const entries = await readdir(vault);
if (entries.length && !entries.includes(marker)) {
  throw new Error("Choose a new or empty vault folder.");
}

const config = join(vault, ".obsidian");
const plugin = join(config, "plugins", "study-cards");
await mkdir(plugin, { recursive: true });
await writeFile(join(vault, marker), "");

const writeOnce = async (path, contents) => {
  try {
    await writeFile(path, contents, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
};
const writeJsonOnce = (path, data) => writeOnce(path, JSON.stringify(data, null, 2) + "\n");
const format = { mode: "collection", level: 2 };
const notes = "Материалы";
const catalog = notes + "/HTTP — 100 вопросов.md";
const entropy = notes + "/Энтропия источника.md";
await mkdir(join(vault, notes), { recursive: true });
await writeOnce(join(vault, catalog), await readFile(join(repo, "scripts", "prototype-http.md")));
await writeOnce(join(vault, entropy), await readFile(join(repo, "scripts", "prototype-entropy.md")));
await writeOnce(join(vault, notes, "Кэш браузера.md"), [
  "# Зачем браузеру кэш?",
  "",
  "Кэш сокращает число повторных сетевых запросов. Если сохранённый ответ устарел, браузер может проверить его через ETag.",
  "",
].join("\n"));
await writeOnce(join(vault, notes, "Шпаргалка HTTP.md"), [
  "# Шпаргалка HTTP",
  "",
  "- `200` — сервер вернул представление.",
  "- `304` — сохранённое представление ещё актуально.",
  "- `404` — ресурс не найден.",
  "",
].join("\n"));
await writeOnce(join(vault, "Старт.md"), [
  "# Макет Study Cards",
  "",
  "Откройте **Study Cards** через значок книги или палитру команд. В разделе «HTTP и кэширование» уже есть 100 карточек.",
  "",
  "- Смените **Вид каталога** и сравните три компоновки. Раскройте любую карточку, чтобы начать стандартную проверку с неё.",
  "- Нажмите **Свободная проверка**. В ответе на первый вопрос есть таблица, код, выноска и ссылка.",
  "- В учебном разделе **Теория информации** откройте [[Материалы/Энтропия источника]] для примера с LaTeX.",
  "- Нажмите **Показать ответ**, выставьте оценку и перейдите дальше. В отчёте можно запустить **Повтор ошибок**.",
  "- Чтобы проверить подключение, добавьте [[Материалы/Кэш браузера]] как одну карточку с вопросом из H1.",
  "",
  "Во время работы вкладку можно закрыть и открыть снова. При перезапуске Obsidian история макета сбрасывается.",
  "",
].join("\n"));

const sectionId = randomUUID();
await writeJsonOnce(join(plugin, "data.json"), {
  activeSection: sectionId,
  sections: [
    {
      id: sectionId, name: "HTTP и кэширование",
      sources: [{ id: randomUUID(), kind: "file", path: catalog, recursive: false, format, excluded: [] }],
    },
    {
      id: randomUUID(), name: "Теория информации",
      sources: [{ id: randomUUID(), kind: "file", path: entropy, recursive: false,
        format: { mode: "single", question: "heading" }, excluded: [] }],
    },
  ],
  knownNotes: {},
  progress: {},
});
await writeJsonOnce(join(config, "community-plugins.json"), ["study-cards"]);
const css = await Promise.all(["styles.css", "src/prototype/styles.css"].map((path) => readFile(join(repo, path), "utf8")));
await writeFile(join(plugin, "styles.css"), css.join("\n"));
await copyFile(join(repo, "manifest.json"), join(plugin, "manifest.json"));
await build({
  entryPoints: [join(repo, "src/prototype/main.ts")],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  target: "es2020",
  outfile: join(plugin, "main.js"),
});
console.log(vault);
