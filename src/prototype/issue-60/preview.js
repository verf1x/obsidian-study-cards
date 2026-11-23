const $ = (selector, root = document) => root.querySelector(selector);
const escape = (text) => String(text).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const params = new URLSearchParams(location.search);
const t = (ru, en) => params.get("lang") === "en" ? en : ru;
const variants = ["A", "B", "C"];
const variant = () => variants.includes(params.get("variant")) ? params.get("variant") : "A";
const arrow = (direction) => '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="' +
  (direction < 0 ? "M10.5 3.5 6 8l4.5 4.5" : "M5.5 3.5 10 8l-4.5 4.5") +
  '" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
const [http, cache, cheat] = await Promise.all(["http", "cache", "cheat"].map(async (name) => {
  const response = await fetch("/" + name + ".txt");
  if (!response.ok) throw new Error("Cannot load " + name);
  return (await response.text()).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}));
const topics = [
  ["Кэширование", ["ETag", "TTL", "Cache-Control", "Vary", "Expires"]],
  ["Соединение", ["TLS", "HTTP/2", "HTTP/3", "TCP", "QUIC"]],
  ["Доставка", ["CDN", "Proxy", "DNS", "CORS", "SSE"]],
  ["Запросы", ["GET", "PUT", "POST", "PATCH", "HEAD"]],
];
const mixed = "# HTTP\n\n" + topics.map(([group, questions]) =>
  "## " + group + "\n\n" + questions.map((word) =>
    "### Как работает " + word + "?\n\n" + ({
      ETag: "ETag идентифицирует версию ресурса. Клиент использует его в условном запросе.",
      TTL: "TTL задаёт период, в течение которого данные можно использовать без повторной проверки.",
      TLS: "TLS устанавливает защищённое соединение и проверяет подлинность сервера.",
      GET: "GET запрашивает представление ресурса.",
    }[word] ?? "Учебная запись для проверки разбора заголовков.")).join("\n\n")).join("\n\n");

function note(id, name, content, saved, folder = "Материалы") {
  let inFence = false;
  const lines = content.split(/\r?\n/);
  const headings = lines.flatMap((line, index) => {
    if (/^ {0,3}\x60{3,}/.test(line)) inFence = !inFence;
    const match = inFence ? null : /^(#{1,6})\s+(.+)$/.exec(line);
    return match ? [{ level: match[1].length, title: match[2], index }] : [];
  });
  return { id, name, folder, lines, headings, saved };
}
const notes = [
  note("cache", "Кэш браузера", cache),
  note("mixed", "HTTP — главы и вопросы", mixed),
  note("http", "HTTP — 100 вопросов", http, "h2"),
  note("cheat", "Шпаргалка HTTP", cheat),
  ...["Сети", "HTTP", "Базы данных", "Локальное хранилище", "API", "Обработка запросов", "Индексы"].map((name, index) =>
    note("other-" + index, name, "# " + name + "\n\nУчебная заметка.", "", "Черновики")),
];
const connected = new Map();
let sections = [], results = [], active = "", filter = "", pane = "practice", layout = null;
let headerMenu = false, sequence = 0, storedNote = "", storedResult = "";
let notice = "";

function reset(seed) {
  sections = seed ? [
    { id: "http", name: "HTTP", source: "Материалы", cards: 100, pending: true },
    { id: "sql", name: "SQL", source: "Собеседование", cards: 12 },
    { id: "sql-other", name: "SQL", source: "Университет", cards: 18 },
  ] : [];
  results = seed ? [
    { id: "r1", section: "http", name: "HTTP", date: "23.11.2026", score: "17 / 20" },
    { id: "r2", section: "sql", name: "SQL", date: "22.11.2026", score: "6 / 8" },
    { id: "r3", section: "sql-other", name: "SQL", date: "20.11.2026", score: "9 / 10" },
    { id: "r4", section: "network", name: t("Сети", "Networks"), date: "18.11.2026", score: "4 / 5" },
  ] : [];
  active = sections[0]?.id ?? "";
  filter = "";
  pane = "practice";
  layout = null;
  notice = "";
  headerMenu = false;
  sequence = 0;
  storedResult = "";
  connected.clear();
  if (seed) connected.set("http", new Set(["other-0"]));
}
reset(params.get("scenario") === "existing");

function countText(count) {
  const ending = count % 100 >= 11 && count % 100 <= 14 ? 0 : count % 10;
  return count + " " + t(ending === 1 ? "карточка" : ending >= 2 && ending <= 4 ? "карточки" : "карточек",
    count === 1 ? "card" : "cards");
}
function cards(note, mode) {
  if (!mode) return [];
  if (mode === "heading" || mode === "filename") {
    const heading = mode === "heading" && note.headings.find(({ level }) => level === 1);
    return [{ title: heading?.title || note.name, body: note.lines.slice(heading ? heading.index + 1 : 0).join("\n") }];
  }
  const level = Number(mode[1]);
  const boundaries = note.headings.filter((heading) => heading.level <= level);
  return boundaries.flatMap((heading, index) => heading.level === level ? [{
    title: heading.title, body: note.lines.slice(heading.index + 1, boundaries[index + 1]?.index).join("\n")
      .replace(/^#qcards\/status\/\S+\r?\n/m, ""),
  }] : []);
}
const navLabels = {
  practice: () => t("Практика", "Practice"), cards: () => t("Карточки", "Cards"), history: () => t("История", "History"),
};
const option = (value, name, selected) => '<option value="' + escape(value) + '"' + (value === selected ? " selected" : "") + ">" + escape(name) + "</option>";
const action = (id, label, className = "", value = "", disabled = false) =>
  '<button type="button" class="' + className + '" data-action="' + id + '" data-value="' + escape(value) +
  '" data-key="' + escape(id + ":" + value) + '"' + (disabled ? " disabled" : "") + ">" + escape(label) + "</button>";
const activeSection = () => sections.find(({ id }) => id === active);
function sectionLabel(section) {
  const twins = sections.filter(({ name }) => name === section.name);
  if (twins.length === 1) return section.name;
  if (section.source && twins.filter(({ source }) => source === section.source).length === 1) return section.name + " · " + section.source;
  return section.name + " (" + (twins.indexOf(section) + 1) + ")";
}
function navigation() {
  const buttons = Object.entries(navLabels).map(([key, label]) =>
    '<button data-action="navigate" data-value="' + key + '" data-key="nav-' + key + '"' +
    (pane === key ? ' aria-current="page"' : "") + ">" + label() + "</button>").join("");
  const switcher = pane === "history" || layout ? "" :
    '<details class="section-menu"' + (headerMenu ? " open" : "") + '><summary data-key="section-menu">' +
    escape(activeSection()?.name ?? t("Выбрать раздел", "Choose section")) + '</summary><div>' +
    sections.map((section) => action("section", sectionLabel(section), "", section.id)).join("") +
    action("new", t("Новый раздел", "New section")) +
    (active ? action("rename", t("Переименовать раздел", "Rename section")) + action("delete", t("Удалить раздел", "Delete section")) : "") + "</div></details>";
  return '<div class="nav-inner">' + buttons + switcher + "</div>";
}
function examples() {
  return '<div class="examples">' + [
    [t("# Что такое кэш?\nКопия данных для быстрого доступа.", "# What is a cache?\nA copy of data for quick access."), 1],
    [t("## Что такое кэш?\nКопия данных.\n## Что такое TTL?\nСрок хранения.", "## What is a cache?\nA copy of data.\n## What is TTL?\nHow long the copy is kept."), 2],
  ].map(([markdown, count]) => '<div class="example"><pre><code>' + escape(markdown) +
    '</code></pre><strong>' + countText(count) + "</strong></div>").join("") + "</div>";
}
function regular() {
  if (!active) return '<section class="simple"><h1>' + t("Начните с ваших заметок", "Start with your notes") +
    '</h1><p>' + t("Выберите Markdown-заметки с материалом, который хотите выучить.", "Choose the Markdown notes you want to study.") +
    '</p>' + examples() + action("connect", t("Подключить заметки", "Connect notes"), "primary") + "</section>";
  const section = activeSection();
  return '<section class="simple"><h1>' + escape(section.name) + '</h1><p class="muted">' + countText(section.cards) +
    '</p>' + (pane === "practice" ? (section.pending ?
      '<p>' + t("Свободная проверка не завершена", "There is an unfinished free check") + "</p>" : "") : "") +
    (notice ? '<p role="status">' + escape(notice) + "</p>" : "") +
    action("connect", t("Подключить заметки", "Connect notes"), "primary") + "</section>";
}
function historyPanel() {
  const history = results.filter(({ section }) => !filter || filter === section);
  const selected = results.find(({ id }) => id === storedResult);
  const display = (result) => {
    const section = sections.find(({ id }) => id === result.section);
    return section ? sectionLabel(section) : result.name + " · " + t("раздел удалён", "deleted section");
  };
  if (selected) return '<section class="simple">' + action("back-history", t("К истории", "Back to history")) +
    '<h1>' + escape(display(selected)) + '</h1><p>' + selected.date + ' · ' + selected.score + '</p></section>';
  return '<section class="simple"><h1>' + t("История проверок", "Free check history") +
    '</h1><label class="form-label">' + t("Учебный раздел", "Study section") +
    '<select data-key="history" data-change="history">' + option("", t("Все разделы", "All sections"), filter) +
    sections.map((section) => option(section.id, sectionLabel(section), filter)).join("") +
    '</select></label>' + (history.length ? history.map((result) =>
      '<article class="result"><div><strong>' + escape(display(result)) + '</strong><small>' +
      result.date + " · " + result.score + '</small></div>' + action("result", t("Результат", "Result"), "", result.id) +
      "</article>").join("") : '<p class="muted">' + t("В этом разделе пока нет результатов.", "No results in this section yet.") + "</p>") +
    "</section>";
}
function startEnrollment(newSection) {
  headerMenu = false;
  layout = {
    newSection, name: t("Новый раздел", "New study section"), query: "", folder: "", help: false, phase: "browse",
    checked: new Set(), mode: new Map(), source: new Map(), focus: "", preview: "", question: 0,
  };
}
const noteModes = (note) => layout.mode.get(note.id) ?? note.saved ?? "";
function status(note) {
  const mode = noteModes(note);
  if (!mode) return t("Выберите способ разбора", "Choose how to make cards");
  if (mode === "levels") return t("Выберите уровень заголовков", "Choose a heading level");
  const description = mode.startsWith("h") && mode !== "heading" ? "#".repeat(Number(mode[1])) : t("Вся заметка", "Whole note");
  return countText(cards(note, mode).length) + " · " + description +
    (note.saved ? t(" · Сохранённый разбор", " · Saved") : "");
}
function format(note) {
  if (note.saved) return '<p class="hint">' + t("Используется сохранённый разбор заметки.", "This note uses its saved format.") + "</p>";
  const mode = noteModes(note);
  const family = mode.startsWith("h") && mode !== "heading" || mode === "levels" ? "levels" : mode ? "single" : "";
  let detail = "";
  let hint = "";
  if (family === "levels") {
    const choices = [1, 2, 3, 4, 5, 6].map((level) =>
      option("h" + level, "#".repeat(level) + " — " + countText(cards(note, "h" + level).length), mode)).join("");
    detail = '<label>' + t("По каким заголовкам делить", "Split at heading level") + '<select data-key="level-' +
      note.id + '" data-change="level" data-id="' + note.id + '">' + option("levels", t("Выберите уровень", "Choose a level"), mode) + choices + "</select></label>";
    hint = t("Заголовок выбранного уровня становится вопросом. Ответ продолжается до следующего заголовка того же или более высокого уровня.",
      "Each heading at this level becomes a question. Its answer ends at the next heading at the same or a higher level.");
    if (mode !== "levels" && !cards(note, mode).length) hint = t("В этой заметке нет заголовков выбранного уровня.", "This note has no headings at this level.");
  } else if (family === "single") {
    detail = '<label>' + t("Откуда взять вопрос", "Question comes from") + '<select data-key="question-' + note.id +
      '" data-change="level" data-id="' + note.id + '">' +
      option("heading", t("Первый заголовок #", "First # heading"), mode) +
      option("filename", t("Имя файла", "File name"), mode) + "</select></label>";
    if (mode === "heading" && !note.headings.some(({ level }) => level === 1)) {
      hint = t("В заметке нет заголовка #. Вопросом станет имя файла.", "Without a # heading, the question comes from the file name.");
    }
  }
  return '<div class="format"><label>' + t("Как сделать карточки", "Make cards from") + '<select data-key="mode-' +
    note.id + '" data-change="mode" data-id="' + note.id + '">' +
    option("", t("Выберите способ", "Choose a method"), family) +
    option("single", t("Вся заметка — одна карточка", "Whole note — one card"), family) +
    option("levels", t("Несколько карточек по заголовкам", "Multiple cards from headings"), family) +
    "</select></label>" + detail + "</div>" + (hint ? '<p class="hint">' + hint + "</p>" : "");
}

function answerMarkup(text) {
  const fence = "\x60\x60\x60";
  const inline = (line) => escape(line)
    .replace(/\[\[Шпаргалка HTTP\]\]/g, '<a href="#linked-note" data-action="linked">' + t("Шпаргалка HTTP", "HTTP quick reference") + "</a>")
    .replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const lines = text.trim().split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    if (line.startsWith(fence)) {
      const code = [];
      while (i + 1 < lines.length && !lines[i + 1].startsWith(fence)) code.push(lines[++i]);
      i += 1;
      blocks.push("<pre><code>" + escape(code.join("\n")) + "</code></pre>");
    } else if (line.startsWith("|")) {
      const rows = [line];
      while (lines[i + 1]?.startsWith("|")) rows.push(lines[++i]);
      blocks.push('<div class="table-wrap"><table>' + rows.filter((row) => !/^[| :\-]+$/.test(row)).map((row, index) => {
        const tag = index ? "td" : "th";
        return "<tr>" + row.slice(1, -1).split("|").map((cell) => "<" + tag + ">" + inline(cell.trim()) + "</" + tag + ">").join("") + "</tr>";
      }).join("") + "</table></div>");
    } else if (line.startsWith(">")) {
      const quote = [line.slice(1).trim().replace(/^\[!\w+\]\s*/, "")];
      while (lines[i + 1]?.startsWith(">")) quote.push(lines[++i].slice(1).trim());
      blocks.push("<blockquote>" + inline(quote.join(" ")) + "</blockquote>");
    } else if (/^#+ /.test(line)) {
      blocks.push("<h3>" + inline(line.replace(/^#+ /, "")) + "</h3>");
    } else {
      blocks.push("<p>" + inline(line) + "</p>");
    }
  }
  return blocks.join("");
}
function preview(note) {
  const mode = noteModes(note);
  const output = cards(note, mode);
  if (!output.length) return "";
  const opened = layout.preview === note.id;
  const id = "preview-" + note.id;
  if (!opened) return '<div class="preview">' + action("preview", t("Предпросмотр", "Preview"), "", note.id) + "</div>";
  const selection = Math.min(layout.question, output.length - 1);
  const card = output[selection];
  return '<section class="preview" id="' + id + '"><header><h2>' + t("Предпросмотр", "Preview") + '</h2>' +
    action("preview", t("Свернуть", "Collapse"), "text", note.id) + '</header>' +
    (output.length > 1 ? '<label class="question-select">' + t("Вопрос", "Question") +
      '<select data-change="preview-question" data-key="preview-question" aria-controls="answer">' +
      output.map(({ title }, index) => option(String(index), (index + 1) + ". " + title, String(selection))).join("") + "</select></label>" : "") +
    '<div class="answer" id="answer"><strong>' + escape(card.title) + "</strong>" +
    (card.body.trim() ? answerMarkup(card.body) : '<p class="muted">' + t("В этой карточке пока нет ответа.", "This card has no answer yet.") + "</p>") +
    "</div></section>";
}
function noteRow(note, how) {
  const selected = layout.checked.has(note.id);
  const detailed = layout.focus === note.id || selected;
  const label = note.name + ".md";
  const key = how === "C" ? "browse" : "configure";
  return '<article class="note"><div class="note-row"' + (selected ? " data-selected" : "") +
    '><label><input type="checkbox" data-key="check-' + note.id + '" data-change="check" data-id="' + note.id +
    '"' + (selected ? " checked" : "") + '><span>' + escape(label) + '<small>' +
    escape(selected || note.saved || noteModes(note) ? status(note) : note.folder) +
    '</small></span></label>' + (how !== "C" ? action(key, t(how === "A" ? "Разбор" : "Открыть", how === "A" ? "Format" : "Open"), "", note.id)
      .replace("<button ", '<button aria-label="' + escape(t(how === "A" ? "Разбор" : "Открыть", how === "A" ? "Format" : "Open") + " " + label) + '" ' +
        (how === "A" ? 'aria-expanded="' + detailed + '" ' : "")) : "") +
    "</div>" + (how === "A" && detailed ? '<div class="note-detail">' + format(note) + preview(note) + "</div>" : "") + "</article>";
}
function enrollment() {
  const how = variant();
  const checked = notes.filter((note) => layout.checked.has(note.id));
  const invalid = checked.filter((note) => !cards(note, noteModes(note)).length);
  const total = checked.reduce((sum, note) => sum + cards(note, noteModes(note)).length, 0);
  const empty = !checked.length || invalid.length > 0 || (layout.newSection && !layout.name.trim());
  const review = how === "C" && layout.phase === "review";
  const query = layout.query.toLocaleLowerCase();
  const available = notes.filter((note) => !connected.get(active)?.has(note.id) || layout.newSection);
  const found = available.filter((note) =>
    (!layout.folder || layout.folder === note.folder) && (note.name + " " + note.folder).toLocaleLowerCase().includes(query));
  const showNote = notes.find(({ id }) => id === layout.focus);
  const title = layout.newSection ? t("Новый раздел", "New section") : t("Подключить заметки", "Connect notes");
  const name = layout.newSection ? '<label for="new-name">' + t("Название раздела", "Section name") +
    '</label><input id="new-name" data-key="new-name" value="' + escape(layout.name) + '">' :
    '<span class="muted">' + escape(activeSection()?.name ?? "") + "</span>";
  const prompt = t("Выберите Markdown-заметки с материалом, который хотите выучить.", "Choose the Markdown notes you want to study.");
  const body = review ? checked.map((note) =>
    '<article class="review-entry"><h2>' + escape(note.name) + '</h2><p class="hint">' + escape(status(note)) +
    '</p><div class="review-detail">' + format(note) + preview(note) + "</div></article>").join("") :
    found.map((note) => noteRow(note, how)).join("") || '<p class="notice">' + t("Заметки не найдены.", "No matching notes.") + "</p>";
  const selector = how === "C" ? '<div class="stage">' + action("browse", t("Выбор заметок", "Choose notes"))
    .replace("<button ", '<button aria-pressed="' + !review + '" ') +
    action("review", t("Разбор выбранных", "Format selected"), "", "", !checked.length)
      .replace("<button ", '<button aria-pressed="' + review + '" ') + "</div>" : "";
  const help = '<details class="help"' + (layout.help ? " open" : "") + '><summary data-key="help">' +
    t("Как из заметок получаются карточки", "How notes become cards") + "</summary>" + examples() + "</details>";
  const toolbar = review ? "" : '<div class="toolbar"><input type="search" data-key="search" id="notes-search" value="' +
    escape(layout.query) + '" placeholder="' + t("Найти заметку", "Find a note") + '" aria-label="' + t("Найти заметку", "Find a note") + '">' +
    '<select data-key="folder" data-change="folder" aria-label="' + t("Найти папку", "Find folder") + '">' +
    option("", t("Все папки", "All folders"), layout.folder) +
    [...new Set(notes.map(({ folder }) => folder))].map((folder) => option(folder, folder, layout.folder)).join("") +
    "</select></div>";
  const context = how === "B" ? '<section class="inspector" data-scroll="inspector" tabindex="0" aria-label="' + t("Разбор заметки", "Note format") +
    '">' + (showNote ? '<h2>' + escape(showNote.name) + "</h2>" + format(showNote) + preview(showNote) :
    '<p class="muted">' + t("Откройте заметку, чтобы выбрать разбор и увидеть карточки.", "Open a note to choose its format and see its cards.") + "</p>") + "</section>" : "";
  const footer = '<footer class="connect-footer"><small role="status">' + t("Выбрано", "Selected") + " · " + countText(total) +
    (invalid.length ? '<span class="warning"> · ' + t("Нужна настройка: ", "Needs a format: ") + invalid.length + "</span>" : "") +
    '</small><div class="actions">' + (how === "C" && !review ?
      action("review", t("К разбору", "Continue to format"), "primary", "", !checked.length) :
      action("finish", layout.newSection ? t("Создать и подключить", "Create and connect") : t("Подключить заметки", "Connect notes"), "primary", "", empty)) +
    action("cancel", t("Отмена", "Cancel"), "text") + "</div></footer>";
  return '<section class="enrollment" data-variant="' + how + '"><div class="enrollment-head"><div class="headline"><h1>' +
    title + "</h1>" + (!layout.newSection ? name : "") + "</div>" + (layout.newSection ? '<div class="headline">' + name + '</div>' : "") +
    '<p class="hint">' + prompt + "</p>" + (sections.length ? help : "") + selector + toolbar +
    '</div><div class="enrollment-body"><section class="note-list" data-scroll="notes" tabindex="0" aria-label="' +
    t("Заметки", "Notes") + '">' + body + "</section>" + context + "</div>" + footer + "</section>";
}
function renderTools() {
  const name = { A: t("В строке", "Inline"), B: t("Рядом", "Side by side"), C: t("После выбора", "Review selected") }[variant()];
  $("#tools").innerHTML =
    '<button data-action="variant" data-value="-1" data-key="previous" aria-label="' + t("Предыдущий вариант", "Previous variant") + '">' + arrow(-1) +
    '</button><strong>' + variant() + ' · ' + name + '</strong><button data-action="variant" data-value="1" data-key="next" aria-label="' +
    t("Следующий вариант", "Next variant") + '">' + arrow(1) + '</button>' +
    action("reset", t("С нуля", "First run"), "", "clean") + action("reset", t("С разделом", "With a section"), "", "existing") +
    action("theme", params.get("theme") === "light" ? t("Тёмная", "Dark") : t("Светлая", "Light")) +
    action("lang", t("EN", "RU"));
}
function render(focus, top = false) {
  const current = document.activeElement?.dataset.key;
  const scroll = Object.fromEntries([...document.querySelectorAll("[data-scroll]")].map((node) => [node.dataset.scroll, node.scrollTop]));
  document.documentElement.dataset.theme = params.get("theme") ?? "dark";
  document.documentElement.lang = t("ru", "en");
  $("#navigation").innerHTML = navigation();
  $("#screen").innerHTML = layout ? enrollment() : pane === "history" ? historyPanel() : regular();
  renderTools();
  if (!top) for (const node of document.querySelectorAll("[data-scroll]")) node.scrollTop = scroll[node.dataset.scroll] ?? 0;
  const key = focus ?? current;
  if (key) $('[data-key="' + CSS.escape(key) + '"]')?.focus({ preventScroll: true });
}
function setParam(key, value) {
  params.set(key, value);
  history.replaceState(null, "", "?" + params);
}
function changeVariant(direction) {
  setParam("variant", variants[(variants.indexOf(variant()) + direction + variants.length) % variants.length]);
  if (!layout && pane !== "history") startEnrollment(!active);
  if (layout) layout.phase = "browse";
  render();
}
function openRename() {
  const dialog = $("#rename");
  const section = activeSection();
  const returnFocus = "section-menu";
  dialog.setAttribute("aria-labelledby", "rename-title");
  dialog.innerHTML = '<form method="dialog"><h2 id="rename-title">' + t("Переименовать раздел", "Rename section") +
    '</h2><label class="form-label">' + t("Название раздела", "Section name") +
    '<input name="rename" required value="' + escape(section.name) + '"></label><div class="actions"><button class="primary" value="save">' +
    t("Сохранить", "Save") + '</button><button value="cancel" formnovalidate>' + t("Отмена", "Cancel") + "</button></div></form>";
  const field = dialog.querySelector("input");
  field.oninput = () => { dialog.querySelector('[value="save"]').disabled = !field.value.trim(); };
  dialog.returnValue = "cancel";
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "save" && field.value.trim()) section.name = field.value.trim();
    render(returnFocus);
  }, { once: true });
  dialog.showModal();
  field.select();
}
function confirmDeletion() {
  const dialog = $("#rename");
  const section = activeSection();
  dialog.setAttribute("aria-labelledby", "delete-title");
  dialog.innerHTML = '<form method="dialog"><h2 id="delete-title">' + t("Удалить раздел «", "Delete section “") +
    escape(section.name) + t("»?", "”?") + '</h2><p>' +
    t("Завершённые результаты останутся в общей истории.", "Completed results stay in the full history.") +
    (section.pending ? " " + t("Незавершённая проверка будет сброшена.", "The unfinished free check will be discarded.") : "") +
    '</p><div class="actions"><button value="cancel" autofocus>' + t("Отмена", "Cancel") +
    '</button><button value="delete">' + t("Удалить раздел", "Delete section") + "</button></div></form>";
  dialog.returnValue = "cancel";
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "delete") {
      for (const result of results) if (result.section === section.id) result.name = section.name;
      const index = sections.indexOf(section);
      sections.splice(index, 1);
      connected.delete(section.id);
      active = (sections[index] ?? sections[index - 1])?.id ?? "";
      if (filter === section.id) filter = "";
      pane = "practice";
      notice = "";
    }
    render("section-menu");
  }, { once: true });
  dialog.showModal();
}
function connect() {
  const selected = notes.filter((note) => layout.checked.has(note.id));
  const total = selected.reduce((sum, note) => sum + cards(note, noteModes(note)).length, 0);
  const isNew = layout.newSection;
  if (isNew) {
    const id = "new-" + (++sequence);
    sections.push({ id, name: layout.name.trim(), cards: total, source: layout.folder || "Материалы" });
    active = id;
  } else {
    activeSection().cards += total;
  }
  connected.set(active, new Set([...(connected.get(active) ?? []), ...selected.map(({ id }) => id)]));
  notice = t("Подключено · ", "Connected · ") + countText(total);
  layout = null;
  pane = isNew ? "practice" : "cards";
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  const { action: name, value } = button.dataset;
  if (name === "variant") return changeVariant(Number(value));
  if (name === "linked") {
    event.preventDefault();
    storedNote = document.activeElement;
    const dialog = $("#linked-note");
    dialog.setAttribute("aria-labelledby", "linked-title");
    dialog.innerHTML = '<form method="dialog"><h2 id="linked-title">' + t("Шпаргалка HTTP", "HTTP quick reference") +
      '</h2><p>' + escape(cheat.split(/\r?\n/).find((line) => line && !line.startsWith("#")) ?? "") +
      '</p><button>' + t("Закрыть", "Close") + '</button></form>';
    dialog.addEventListener("close", () => storedNote?.focus(), { once: true });
    dialog.showModal();
    return;
  }
  if (name === "navigate") { pane = value; layout = null; headerMenu = false; storedResult = ""; }
  if (name === "section") { active = value; headerMenu = false; notice = ""; }
  if (name === "new" || name === "connect") startEnrollment(name === "new" || !active);
  if (name === "rename" || name === "delete") {
    headerMenu = false;
    render();
    return name === "rename" ? openRename() : confirmDeletion();
  }
  if (name === "cancel") layout = null;
  if (name === "configure") layout.focus = layout.focus === value && variant() === "A" ? "" : value;
  if (name === "preview") { layout.preview = layout.preview === value ? "" : value; layout.question = 0; }
  if (name === "browse" || name === "review") { layout.phase = name; layout.preview = ""; }
  if (name === "finish") connect();
  if (name === "result") storedResult = value;
  if (name === "back-history") storedResult = "";
  if (name === "reset") { setParam("scenario", value); reset(value === "existing"); }
  if (name === "theme") setParam("theme", params.get("theme") === "light" ? "dark" : "light");
  if (name === "lang") setParam("lang", t("en", "ru"));
  const focus = name === "navigate" ? "nav-" + value : name === "section" ? "section-menu" : undefined;
  render(focus, ["navigate", "browse", "review", "result", "back-history"].includes(name));
});
document.addEventListener("input", ({ target }) => {
  if (target.id === "new-name") {
    layout.name = target.value;
    const submit = $('[data-action=finish]');
    if (submit) submit.disabled = !layout.name.trim() || !layout.checked.size ||
      notes.some((note) => layout.checked.has(note.id) && !cards(note, noteModes(note)).length);
  }
  if (target.id === "notes-search") {
    const position = target.selectionStart;
    layout.query = target.value;
    render("search", true);
    try { $("#notes-search").setSelectionRange(position, position); } catch {}
  }
});
document.addEventListener("change", ({ target }) => {
  const { change, id } = target.dataset;
  if (!change) return;
  if (change === "history") filter = target.value;
  if (change === "folder") layout.folder = target.value;
  if (change === "check") {
    if (target.checked) { layout.checked.add(id); layout.focus = id; }
    else layout.checked.delete(id);
  }
  if (change === "mode") {
    const mode = target.value === "single" ? layout.source.get(id) ?? "heading" : target.value;
    layout.mode.set(id, mode);
    layout.question = 0;
  }
  if (change === "level") {
    layout.mode.set(id, target.value);
    if (["filename", "heading"].includes(target.value)) layout.source.set(id, target.value);
    layout.question = 0;
  }
  if (change === "preview-question") layout.question = Number(target.value);
  render(undefined, ["folder", "history"].includes(change));
});
document.addEventListener("toggle", ({ target }) => {
  if (!target.isConnected) return;
  if (target.matches(".help") && layout) layout.help = target.open;
  if (target.matches(".section-menu")) headerMenu = target.open;
}, true);
document.addEventListener("keydown", (event) => {
  if (event.target.closest("input, select, textarea, [contenteditable], dialog")) return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    changeVariant(event.key === "ArrowLeft" ? -1 : 1);
  }
});
if (params.get("screen") === "connect") startEnrollment(!active);
render();
