// Review-only prototype. Three layouts share an in-memory sample vault.
const workspace = document.querySelector("#workspace");
const lab = document.querySelector("#lab");
const dialog = document.querySelector("#dialog");
const params = new URLSearchParams(location.search);
const variants = ["A", "B", "C"];
let variant = variants.includes(params.get("variant")) ? params.get("variant") : "A";
let language = params.get("lang") === "en" ? "en" : "ru";
let theme = params.get("theme") === "light" ? "light" : "dark";
const t = (ru, en) => language === "ru" ? ru : en;
const names = () => ({ A: t("Практика", "Practice"), B: t("Разделы", "Sections"), C: t("Карточки", "Cards") });

const sources = [
  { id: "http", path: "Backend/HTTP.md", cards: [
    ["etag", "What is an ETag and how does revalidation work?", "An ETag identifies a particular representation of a resource. On a later request the client sends the tag in If-None-Match. The server can respond with 304 Not Modified when that representation is still current."],
    ["verbs", "Which HTTP methods are idempotent?", "GET, HEAD, OPTIONS, TRACE, PUT and DELETE are idempotent. Repeating the same request has the same intended effect as making it once."],
    ["cache", "How does Cache-Control: no-cache work?", "The cache may store the response. It must validate that response with the origin before reusing it."],
    ["vary", "What does the Vary response header do?", "It specifies which request headers a cache must consider when determining whether a stored response is reusable."],
    ["status", "When should an API return 409 Conflict?", "Use 409 when the request conflicts with the current state of the resource, for example a version mismatch on update."],
  ] },
  { id: "tls", path: "Backend/TLS handshake.md", cards: [
    ["tls", "What happens during a TLS 1.3 handshake?", "The peers negotiate cryptographic parameters, authenticate the server and derive shared traffic keys. Each peer then confirms the transcript with a Finished message."],
  ] },
  { id: "sql", path: "Database/Transactions.md", cards: [
    ["sql", "What does transaction isolation protect?", "Isolation limits how concurrent transactions can observe and affect one another. The guarantees depend on the chosen isolation level."],
  ] },
];
const cards = sources.flatMap(source => source.cards.map(([id, question, answer]) => ({
  id, question, answer, source: source.id, path: source.path,
})));
const databaseName = "SQL";
const httpName = "HTTP";
const initial = (scenario = "sample") => ({
  sections: scenario === "empty" ? [] : [
    { id: 1, name: httpName, sources: ["http", "tls"], remembered: [] },
    { id: 2, name: databaseName, sources: ["sql"], remembered: [] },
  ],
  current: scenario === "empty" ? null : 1,
  page: "home",
  scenario,
  setup: null,
  working: null,
  results: scenario === "empty" ? [] : [{ section: 1, name: httpName, ids: ["etag", "verbs", "tls"], grades: { etag: "good", verbs: "miss", tls: "good" } }],
  filters: { query: "", source: "" },
  recovery: scenario === "recovery",
  enrollment: null,
  opened: new Set(),
});
let state = initial(params.get("scenario") === "empty" ? "empty" : "sample");
let catalogRows;
let manualRows;

function el(tag, props = {}, ...children) {
  const x = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "class") x.className = v;
    else if (k.startsWith("on")) x.addEventListener(k.slice(2), v);
    else if (k in x && !k.startsWith("aria")) x[k] = v;
    else x.setAttribute(k, v);
  }
  x.append(...children.flat(Infinity).filter(child => child != null));
  return x;
}
const div = (cls, ...children) => el("div", { class: cls }, children);
const heading = (n, title) => el("h" + n, {}, title);
const text = (value, cls) => el("p", { class: cls }, value);
const meta = value => el("small", {}, value);
const iconPaths = {
  deck: '<rect x="6" y="3" width="14" height="16" rx="2"/><path d="M16 22H6a3 3 0 0 1-3-3V7m7 1h6m-6 4h4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/><circle cx="12" cy="12" r="7"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
};
function icon(name) {
  const span = el("span", { "aria-hidden": "true" });
  span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + iconPaths[name] + "</svg>";
  return span;
}
const button = (title, run, props = {}, content = title) =>
  el("button", { type: "button", onclick: run, ...props }, content);
const primary = (title, run, props = {}) => button(title, run, { class: "primary", ...props });
const quiet = (title, run, props = {}, content = title) => button(title, run, { class: "quiet", ...props }, content);
const actions = (...items) => div("actions", items);
const row = (title, detail, ...controls) => div("row", div("tight", heading(3, title), detail ? meta(detail) : null), actions(controls));
const current = () => state.sections.find(s => s.id === state.current);
const eligible = (section = current()) => cards.filter(card => section?.sources.includes(card.source));
const lookup = id => cards.find(card => card.id === id);
const labels = () => ({
  practice: t("Практика", "Practice"), cards: t("Карточки", "Cards"), history: t("История", "History"),
  newSection: t("Новый раздел", "New section"), connect: t("Подключить заметки", "Connect notes"),
  start: t("Начать проверку", "Start free check"), cancel: t("Отмена", "Cancel"), back: t("Назад", "Back"),
  retry: t("Повторить ошибки", "Retry mistakes"), resume: t("Продолжить проверку", "Continue free check"),
});
const ruPlural = new Intl.PluralRules("ru");
const cardCount = n => n + " " + t(({ one: "карточка", few: "карточки" })[ruPlural.select(n)] ?? "карточек", n === 1 ? "card" : "cards");
const searchMatches = (card, q) => (card.question + " " + card.path).toLowerCase().includes(q.trim().toLowerCase());
const tell = value => { document.querySelector("#announcement").textContent = value; };

function show(page, focus = true) {
  if (page === "review" && state.page !== "review") {
    state.reviewIndex = 0;
    state.reviewRevealed = false;
  }
  state.page = page;
  render(focus);
}

function switchSection(id) {
  state.current = id;
  state.filters = { query: "", source: "" };
  state.opened.clear();
  show(state.page === "cards" ? "cards" : "home");
}

function updateUrl() {
  const url = new URL(location.href);
  url.searchParams.set("variant", variant);
  url.searchParams.set("lang", language);
  url.searchParams.set("theme", theme);
  if (state.scenario === "empty") url.searchParams.set("scenario", "empty");
  else url.searchParams.delete("scenario");
  history.replaceState(null, "", url);
}

function shiftVariant(delta) {
  variant = variants[(variants.indexOf(variant) + delta + variants.length) % variants.length];
  updateUrl();
  render();
  document.querySelector(delta < 0 ? "#variant-prev" : "#variant-next")?.focus();
  tell(variant + " · " + names()[variant]);
}

function modal(title, ...children) {
  dialog.setAttribute("aria-labelledby", "dialog-heading");
  dialog.replaceChildren(el("h2", { id: "dialog-heading" }, title), div("stack", children));
  if (!dialog.open) dialog.showModal();
}

const close = () => dialog.close();
const modalCancel = () => quiet(labels().cancel, close, { autofocus: true });

function chooseScenario() {
  const start = scenario => {
    state = initial(scenario);
    updateUrl();
    close();
    render(true);
  };
  modal(t("Сценарий прототипа", "Prototype scenario"),
    text(t("Выбор сценария сбрасывает учебные данные макета.", "Choosing a scenario resets the sample study data.")),
    row(t("Первый запуск", "First use"), t("Пустой каталог с учебными заметками", "Empty catalog with sample notes"), button(t("Открыть", "Open"), () => start("empty"))),
    row(t("Возврат к учёбе", "Returning learner"), t("Два раздела и результат проверки", "Two sections and a free check result"), button(t("Открыть", "Open"), () => start("sample"))),
    row(t("Сбой хранения", "Storage problem"), t("Проверить доступ к восстановлению", "Find the recovery actions"), button(t("Открыть", "Open"), () => start("recovery"))),
    actions(modalCancel()));
}

function settings() {
  modal(t("Настройки Study Cards", "Study Cards settings"),
    el("details", { class: "boxed pad" }, el("summary", {}, t("Дополнительно · данные и снимки", "Advanced · data and snapshots")),
      div("stack pad", text(t("Снимки нужны для ручного переноса и восстановления прогресса.", "Snapshots allow manual transfer and recovery of study progress.")),
        actions(button(t("Экспортировать снимок", "Export snapshot"), () => snapshotNotice()),
          button(t("Импортировать снимок", "Import snapshot"), () => snapshotNotice())))),
    actions(quiet(t("Закрыть", "Close"), close)));
}

function snapshotNotice() {
  modal(t("Снимки", "Snapshots"), text(t("В прототипе показано расположение инструментов переноса.", "This prototype previews the placement of data transfer tools.")),
    actions(button(labels().back, settings), quiet(t("Закрыть", "Close"), close)));
}

function top() {
  return el("header", { class: "top" }, div("brand", icon("deck"), "Study Cards"),
    div("tools", quiet(t("Настройки", "Settings"), settings, { "aria-label": t("Настройки", "Settings") },
      div("button-label", icon("gear"), el("span", { class: "tool-text" }, t("Настройки", "Settings"))))));
}

function nav(asRail = false) {
  const l = labels();
  const pages = variant === "C" ? [["cards", l.cards], ["practice", l.practice], ["history", l.history]]
    : [["practice", l.practice], ["cards", l.cards], ["history", l.history]];
  const page = state.page === "home" ? (variant === "C" ? "cards" : "practice") : state.page;
  return el("nav", { class: asRail ? "tight" : "nav", "aria-label": t("Рабочая область", "Workspace") },
    pages.map(([key, title]) => quiet(title, () => show(key), { "aria-current": key === page ? "page" : null })));
}

function sectionMenu() {
  const name = current()?.name ?? t("Выбрать раздел", "Choose section");
  const trigger = el("summary", { class: "button-label", "aria-label": t("Учебный раздел", "Study section") + " · " + name },
    el("span", { class: "section-label" }, name), icon("chevron"));
  return el("details", { class: "menu" }, trigger,
    div("menu-panel", sectionActions()));
}

function sectionActions() {
  const l = labels();
  return [
    ...state.sections.map(section => quiet(section.name, () => switchSection(section.id), { "aria-pressed": section.id === state.current })),
    state.sections.length ? el("hr") : null,
    button(l.newSection, () => enroll(true), { class: "quiet" }, div("button-label", icon("plus"), l.newSection)),
    current() ? quiet(t("Удалить раздел…", "Delete section…"), confirmDeletion, { class: "quiet danger" }) : null,
  ];
}

function rail() {
  return el("aside", { class: "rail stack" },
    div("rail-title", heading(3, t("Учебные разделы", "Study sections"))),
    div("tight", sectionActions()), nav(true));
}

function header(title, detail, ...controls) {
  return div("line headline", div("tight", el("h1", { id: "view-heading", tabIndex: -1 }, title), detail ? text(detail, "muted") : null),
    controls.length ? actions(controls) : null);
}

function empty() {
  const l = labels();
  return div("empty", header(t("Начните с ваших заметок", "Start with your notes")),
    text(t("Подключите заметку с одной карточкой или целый сборник вопросов.",
      "Connect a single-card note or a question collection."), "muted"),
    primary(l.connect, () => enroll(true)));
}

function practice(section) {
  const l = labels();
  const ready = eligible(section);
  const due = Math.min(ready.length, 2);
  const latest = state.results.findLast(r => r.section === section.id && !r.retry);
  const misses = latest ? score(latest).missed : 0;
  const freeCheck = div("line pad tinted",
    div("tight", heading(2, state.working ? l.resume : t("Свободная проверка", "Free check")),
      meta(state.working ? state.working.name + " · " + (state.working.index + 1) + " / " + state.working.ids.length
        : t("Вспомните ответы и оцените себя", "Recall the answers and grade yourself"))),
    state.working ? primary(l.resume, () => show("session")) : primary(t("Проверить себя", "Test yourself"), () => setup(), { disabled: !ready.length }));
  const reviews = div("rows",
    row(t("Интервальное повторение", "Spaced repetition"), t("Доступно сейчас · ", "Due now · ") + due,
      button(t("Открыть", "Open"), () => show("review"), { disabled: !ready.length })),
    misses ? row(t("Ошибки последней проверки", "Mistakes from the last check"), cardCount(misses), button(l.retry, () => retry(latest))) : null);
  const next = state.working && ready.length ? quiet(t("Новая проверка", "New free check"), () => setup()) : null;
  const noCards = !ready.length ? text(t("Чтобы начать проверку, подключите заметки во вкладке «Карточки».", "Connect notes in Cards to start a free check."), "notice") : null;
  if (variant === "B") {
    return div("stack", header(section.name, cardCount(ready.length), next), noCards,
      div("columns", div("stack", freeCheck, div("rows",
        row(t("Карточки раздела", "Section cards"), cardCount(ready.length), button(l.cards, () => show("cards"))))),
      div("stack", heading(2, t("Повторение", "Review")), reviews)));
  }
  return div("stack", header(section.name, cardCount(ready.length), next), noCards, freeCheck, reviews);
}

function catalog(section) {
  const l = labels();
  const search = el("input", { type: "search", value: state.filters.query,
    "aria-label": t("Поиск карточек", "Search cards"), placeholder: t("Вопрос или путь к заметке", "Question or note path"),
    oninput: e => { state.filters.query = e.target.value; drawCatalog(section); } });
  catalogRows = div("catalog-list rows");
  drawCatalog(section);
  const review = variant === "C" && eligible().length ? div("line tinted pad",
    div("tight", heading(2, state.working ? l.resume : t("Свободная проверка", "Free check")),
      meta(state.working ? state.working.name + " · " + (state.working.index + 1) + " / " + state.working.ids.length : t("Свободная проверка по карточкам этого раздела", "Free check using cards in this section"))),
    primary(state.working ? l.resume : t("Проверить себя", "Test yourself"), () => state.working ? show("session") : setup())) : null;
  return div("stack", header(variant === "C" ? section.name : l.cards, cardCount(eligible().length),
      button(l.connect, () => enroll(false)), quiet(t("Источники", "Sources") + " · " + section.sources.length, () => show("sources"))),
    review, eligible().length ? div("catalog-tools", search, state.filters.source
      ? button(t("Все заметки", "All notes"), () => { state.filters.source = ""; render(); }) : null) : null,
    catalogRows);
}

function drawCatalog(section) {
  const available = eligible(section);
  const found = available.filter(card => searchMatches(card, state.filters.query) && (!state.filters.source || state.filters.source === card.source));
  catalogRows.replaceChildren(...(found.length ? found.map(card => el("details", {
    open: state.opened.has(card.id), ontoggle: e => e.target.open ? state.opened.add(card.id) : state.opened.delete(card.id),
  }, el("summary", {}, card.question, el("br"), meta(card.path)),
    div("stack pad", answer(card), actions(button(t("Начать с этой карточки", "Start from this card"), () => setup(card.id)),
      quiet(t("Открыть заметку", "Open note"), () => notePreview(sources.find(s => s.id === card.source)))))))
    : [text(available.length ? t("Карточки не найдены.", "No cards found.") : t("Подключите заметки, чтобы здесь появились карточки.", "Connect notes to add cards here."), "pad muted")]));
}

function answer(card) {
  return div("answer", text(card.answer),
    card.id === "etag" ? [
      el("pre", {}, "GET /profile HTTP/1.1\nIf-None-Match: " + '"v3"'),
      el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Status"), el("th", {}, "Meaning"))),
        el("tbody", {}, el("tr", {}, el("td", {}, "304"), el("td", {}, "Use the cached copy")),
          el("tr", {}, el("td", {}, "200"), el("td", {}, "Store the new representation")))),
    ] : null);
}

function sourcesPage(section) {
  return div("stack", header(t("Источники", "Sources"), section.name, primary(labels().connect, () => enroll(false))), div("rows",
    sources.filter(s => section.sources.includes(s.id)).map(source => row(source.path, cardCount(source.cards.length),
      quiet(t("Открыть заметку", "Open note"), () => notePreview(source)),
      button(t("Отключить", "Disconnect"), () => confirmDisconnect(section, source)))),
    section.sources.length ? null : text(t("В этом разделе ещё нет подключённых заметок.", "This section has no connected notes yet."), "pad muted")),
    actions(quiet(t("К карточкам", "Back to cards"), () => show("cards"))));
}

function notePreview(source) {
  modal(source.path, ...source.cards.map(([id]) => div("tight", heading(3, lookup(id).question), answer(lookup(id)))),
    actions(quiet(t("Закрыть", "Close"), close)));
}

function confirmDisconnect(section, source) {
  modal(t("Отключить заметку?", "Disconnect note?"), text(source.path),
    text(t("Её карточки исчезнут из этого раздела. Заметка, прогресс и результаты сохранятся.",
      "Its cards will leave this section. The note, progress and results will remain.")),
    actions(modalCancel(), button(t("Отключить", "Disconnect"), () => {
      section.sources = section.sources.filter(id => source.id !== id);
      state.filters.source = "";
      close();
      render(true);
    }, { class: "danger" })));
}

function enroll(creating) {
  state.enrollment = { creating, chosen: new Set(), expanded: new Set(), name: "", nameEdited: false, from: state.page };
  show("enroll");
}

function enrollment() {
  const l = labels();
  const draft = state.enrollment;
  const choices = sources.filter(source => draft.creating || !current().sources.includes(source.id));
  const countReadout = el("small", { role: "status" });
  const save = () => {
    if (draft.creating) {
      const first = state.sections.length === 0 && !state.results.length;
      const id = Math.max(0, ...state.sections.map(s => s.id), ...state.results.map(r => r.section)) + 1;
      state.sections.push({ id, name: draft.name.trim(), sources: [...draft.chosen], remembered: [], introductory: first });
      state.current = id;
    } else current().sources.push(...draft.chosen);
    state.enrollment = null;
    state.filters = { query: "", source: "" };
    show(draft.creating ? "home" : "cards");
    tell(t("Карточки добавлены", "Cards added"));
  };
  const cancel = () => { state.enrollment = null; show(draft.from); };
  const confirm = primary(draft.creating ? t("Создать и подключить", "Create and connect") : l.connect, save);
  const nameInput = draft.creating ? el("input", { type: "text", value: draft.name, oninput: e => {
    draft.name = e.target.value;
    draft.nameEdited = true;
    update();
  } }) : null;
  function update() {
    const selected = choices.filter(source => draft.chosen.has(source.id));
    if (nameInput && !draft.nameEdited) {
      draft.name = selected.length ? selected[0].path.split("/")[0] : "";
      nameInput.value = draft.name;
    }
    const count = selected.reduce((total, source) => total + source.cards.length, 0);
    countReadout.textContent = t("Выбрано · ", "Selected · ") + cardCount(count);
    confirm.disabled = !selected.length || (draft.creating && !draft.name.trim());
  }
  const notes = choices.map(source => {
    const previewId = "preview-" + source.id;
    const preview = el("div", { class: "stack enrollment-preview", id: previewId, hidden: !draft.expanded.has(source.id) },
      source.cards.map(([id]) => div("tight", heading(3, lookup(id).question), answer(lookup(id)))));
    const previewButton = quiet(t("Предпросмотр", "Preview"), () => {
      preview.hidden = !preview.hidden;
      if (preview.hidden) draft.expanded.delete(source.id);
      else draft.expanded.add(source.id);
      previewButton.setAttribute("aria-expanded", String(!preview.hidden));
    }, { "aria-controls": previewId, "aria-expanded": String(!preview.hidden),
      "aria-label": t("Предпросмотр · ", "Preview · ") + source.path });
    const choice = el("label", { class: "pick" },
      el("input", { type: "checkbox", checked: draft.chosen.has(source.id), onchange: e => {
        if (e.target.checked) draft.chosen.add(source.id);
        else draft.chosen.delete(source.id);
        update();
      } }), div("tight", source.path, meta(cardCount(source.cards.length))));
    return div("enrollment-note", div("enrollment-row", choice, previewButton), preview);
  });
  update();
  return div("stack", header(draft.creating ? l.newSection : l.connect, draft.creating ? null : current().name),
    nameInput ? el("label", { class: "field" }, t("Название раздела", "Section name"), nameInput) : null,
    notes.length ? div("boxed enrollment-list", notes)
      : text(t("Все учебные заметки уже подключены.", "All sample notes are already connected."), "muted"),
    div("line", countReadout, actions(confirm, quiet(l.cancel, cancel))));
}

function confirmDeletion() {
  const section = current();
  const hasCheck = state.working?.section === section.id;
  const remove = () => {
    const index = state.sections.indexOf(section);
    state.sections.splice(index, 1);
    state.current = state.sections[index]?.id ?? state.sections.at(-1)?.id ?? null;
    state.filters = { query: "", source: "" };
    state.opened.clear();
    if (hasCheck) state.working = null;
    close();
    show("home");
    tell(t("Раздел удалён", "Section deleted"));
  };
  modal(t("Удалить раздел «" + section.name + "»?", "Delete “" + section.name + "”?"),
    text(t("Заметки, прогресс по карточкам и завершённые проверки сохранятся. Результаты доступны в «Истории».",
      "Notes, card progress and completed free checks will remain. Results are available in History.")),
    hasCheck ? text(t("Незавершённая проверка этого раздела будет сброшена.", "This section’s unfinished free check will be discarded."), "notice alert") : null,
    actions(modalCancel(), hasCheck ? button(labels().resume, () => { close(); show("session"); }) : null,
      button(t("Удалить раздел", "Delete section"), remove, { class: "danger" })));
}

function setup(anchor = null) {
  const introductory = !anchor && current().introductory;
  state.setup = { method: introductory ? "random" : "ordered", count: Math.min(eligible().length, introductory ? 5 : 20),
    anchor, query: "", chosen: new Set(anchor ? [anchor] : current().remembered), from: state.page };
  show("setup");
}

function freeCheckSetup() {
  const l = labels();
  const draft = state.setup;
  const section = current();
  const pool = eligible(section);
  const ordered = draft.anchor ? pool.slice(pool.findIndex(card => card.id === draft.anchor)) : pool;
  const count = Math.min(draft.count, draft.method === "ordered" ? ordered.length : pool.length);
  const changeMethod = method => {
    draft.method = method;
    render();
    document.querySelector("#method-" + method)?.focus();
  };
  const methods = [["random", t("Случайно", "Random")], ["ordered", t("По порядку", "In source order")], ["manual", t("Выбрать карточки", "Select cards")]];
  const countReadout = meta("");
  countReadout.setAttribute("role", "status");
  const start = primary(l.start, () => {
    const requested = Math.min(draft.count, draft.method === "ordered" ? ordered.length : pool.length);
    if (draft.method === "manual") {
      const ids = pool.filter(card => draft.chosen.has(card.id)).map(card => card.id);
      if (ids.length && ids.length === draft.chosen.size) launch(section, ids, { manual: true });
    } else if (draft.method === "ordered") launch(section, ordered.slice(0, requested).map(c => c.id));
    else {
      const shuffled = [...pool];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      launch(section, shuffled.slice(0, requested).map(c => c.id));
    }
  });
  const controls = actions(start, quiet(l.cancel, () => { state.setup = null; show(draft.from); }));
  const content = div("stack setup", header(t("Свободная проверка", "Free check"), section.name),
    actions(methods.map(([key, name]) => button(name, () => changeMethod(key), { id: "method-" + key, "aria-pressed": draft.method === key }))));
  if (draft.method !== "manual") {
    content.append(el("label", { class: "field" }, t("Количество карточек", "Number of cards"),
      el("input", { type: "number", min: 1, max: draft.method === "ordered" ? ordered.length : pool.length, value: count,
        oninput: e => { draft.count = e.target.valueAsNumber || 0; start.disabled = !e.target.validity.valid || !draft.count; } })));
    if (draft.method === "ordered" && draft.anchor) content.append(text(lookup(draft.anchor).question, "notice"));
    start.disabled = !count;
  } else {
    const draw = () => {
      const activeIds = new Set(pool.map(card => card.id));
      const stale = [...draft.chosen].filter(id => !activeIds.has(id));
      const scrollTop = manualRows.scrollTop;
      const focused = document.activeElement.id;
      const groups = sources.map(source => {
        const noteCards = pool.filter(card => card.source === source.id);
        const visible = noteCards.filter(card => searchMatches(card, draft.query));
        if (!visible.length) return null;
        const picked = noteCards.filter(card => draft.chosen.has(card.id)).length;
        const all = el("input", { type: "checkbox", id: "group-" + source.id, checked: picked === noteCards.length,
          indeterminate: picked > 0 && picked < noteCards.length, onchange: e => {
            for (const card of noteCards) {
              if (e.target.checked) draft.chosen.add(card.id);
              else draft.chosen.delete(card.id);
            }
            draw();
          } });
        return el("section", {}, el("label", { class: "pick group" }, all, source.path + " · " + picked + "/" + noteCards.length),
          visible.map(card => checkbox(card, false)));
      }).filter(Boolean);
      const unavailable = stale.length ? div("pad notice alert", heading(3, t("Недоступные карточки", "Unavailable cards")),
        text(t("Подключите заметку снова или снимите отметки перед запуском.", "Reconnect the source or uncheck these cards before starting.")),
        stale.map(id => checkbox(lookup(id), true))) : null;
      manualRows.replaceChildren(...[unavailable, ...groups, groups.length ? null : text(t("Карточки не найдены.", "No matching cards."), "pad muted")].filter(Boolean));
      manualRows.scrollTop = scrollTop;
      if (focused.startsWith("pick-") || focused.startsWith("group-")) document.getElementById(focused)?.focus({ preventScroll: true });
      countReadout.textContent = t("Выбрано · ", "Selected · ") + cardCount(draft.chosen.size);
      start.disabled = !draft.chosen.size || stale.length > 0;
    };
    const checkbox = (card, stale) => el("label", { class: "pick item" },
      el("input", { type: "checkbox", id: "pick-" + card.id, checked: draft.chosen.has(card.id), onchange: e => {
        if (e.target.checked && !stale) draft.chosen.add(card.id);
        else draft.chosen.delete(card.id);
        draw();
      } }), card.question);
    const search = el("input", { type: "search", value: draft.query,
      placeholder: t("Вопрос или путь к заметке", "Question or note path"), "aria-label": t("Поиск карточек", "Search cards"),
      oninput: e => { draft.query = e.target.value; draw(); } });
    manualRows = div("boxed picker");
    draw();
    content.append(search, manualRows);
    if (draft.anchor) content.append(meta(t("Из карточки подбор начинается с неё.", "Opening setup from a card starts the selection with that card.")));
    else if (section.remembered.length) content.append(meta(t("Подставлен набор из последнего ручного запуска.", "Loaded the last launched manual set.")));
    content.append(div("setup-footer tight",
      div("line", countReadout, quiet(t("Снять все отметки", "Clear selection"), () => { draft.chosen.clear(); draw(); })),
      controls));
    return content;
  }
  content.append(controls);
  return content;
}

function launch(section, ids, { manual = false, retry = false } = {}) {
  if (!ids.length) return;
  const commit = () => {
    if (manual) section.remembered = [...ids];
    if (!retry) section.introductory = false;
    state.working = { section: section.id, name: section.name, ids, grades: {}, index: 0, revealed: false, retry };
    state.setup = null;
    show("session");
  };
  if (!state.working) { commit(); return; }
  modal(t("Есть незавершённая проверка", "A free check is in progress"),
    text(state.working.name + " · " + (state.working.index + 1) + " / " + state.working.ids.length),
    actions(modalCancel(), button(labels().resume, () => { close(); state.setup = null; show("session"); }),
      button(t("Заменить проверку", "Replace check"), () => { close(); commit(); }, { class: "danger" })));
}

function session() {
  const working = state.working;
  const id = working.ids[working.index];
  const card = lookup(id);
  const grade = working.grades[id];
  const unavailable = !eligible(state.sections.find(s => s.id === working.section)).some(c => c.id === id);
  const more = working.index + 1 < working.ids.length;
  const finishing = () => {
    const done = Object.keys(working.grades).length;
    modal(t("Завершить проверку?", "Finish free check?"),
      text(t("Оценено · ", "Graded · ") + done + "/" + working.ids.length),
      actions(modalCancel(), primary(t("Сохранить результат", "Save result"), () => {
        state.results.push({ ...working, grades: { ...working.grades } });
        state.result = state.results.at(-1);
        state.working = null;
        close();
        show("result");
      })));
  };
  return div("stack session",
    div("line", quiet(t("К практике", "Back to practice"), () => show("practice")),
      meta((working.retry ? labels().retry : working.name) + " · " + (working.index + 1) + " / " + working.ids.length)),
    el("progress", { max: working.ids.length, value: working.index + 1, "aria-label": t("Позиция в проверке", "Check position") }),
    header(card.question, card.path),
    unavailable ? text(t("Карточка сейчас недоступна в этом разделе.", "This card is currently unavailable in the section."), "notice alert")
      : working.revealed || grade ? div("stack", answer(card), actions(
        ...[["miss", t("Ошибка", "Incorrect")], ["good", t("Верно", "Correct")]].map(([key, title]) => button(title, () => {
          working.grades[id] = key;
          render();
          document.querySelector("#continue").focus();
        }, { "aria-pressed": grade === key }))))
        : actions(primary(t("Показать ответ", "Reveal answer"), () => { working.revealed = true; render(true); })),
    actions(quiet(t("Предыдущая", "Previous"), () => {
      working.index -= 1;
      working.revealed = false;
      render(true);
    }, { disabled: !working.index }),
    primary(more ? t("Следующая", "Next") : t("К результату", "See result"), () => {
      if (!more) { finishing(); return; }
      working.index += 1;
      working.revealed = false;
      render(true);
    }, { id: "continue", disabled: !grade && !unavailable }),
    more || !grade ? quiet(t("Завершить сейчас", "Finish now"), finishing) : null));
}

function retry(result) {
  const section = state.sections.find(s => s.id === result.section);
  if (!section) return;
  const ready = new Set(eligible(section).map(card => card.id));
  const missed = result.ids.filter(id => result.grades[id] === "miss");
  const available = missed.filter(id => ready.has(id));
  if (available.length === missed.length) { launch(section, available, { retry: true }); return; }
  modal(labels().retry, text(t("Недоступно карточек · ", "Unavailable cards · ") + (missed.length - available.length)),
    actions(modalCancel(), primary(labels().start, () => { close(); launch(section, available, { retry: true }); }, { disabled: !available.length })));
}

function score(result) {
  const grades = Object.values(result.grades);
  const correct = grades.filter(grade => grade === "good").length;
  const missed = grades.filter(grade => grade === "miss").length;
  return { correct, missed, skipped: result.ids.length - correct - missed };
}

function historyScreen() {
  const l = labels();
  const all = state.historyScope !== "current";
  const results = all ? state.results : state.results.filter(r => r.section === state.current);
  const filter = key => { state.historyScope = key; render(); document.querySelector("#history-" + key)?.focus(); };
  return div("stack", header(t("История проверок", "Free check history")),
    actions(button(t("Все разделы", "All sections"), () => filter("all"), { id: "history-all", "aria-pressed": all }),
      current() ? button(current().name, () => filter("current"), { id: "history-current", "aria-pressed": !all }) : null),
    div("rows", [...results].reverse().map(r => {
      const exists = state.sections.some(s => s.id === r.section);
      return row(r.name + (exists ? "" : t(" · раздел удалён", " · section deleted")),
        (r.retry ? l.retry : t("Свободная проверка", "Free check")) + " · " + score(r).correct + "/" + r.ids.length,
        button(t("Результат", "Result"), () => { state.result = r; show("result"); }));
    }), !results.length ? text(t("Завершённых проверок пока нет.", "There are no completed checks yet."), "pad muted") : null));
}

function report() {
  const r = state.result;
  const l = labels();
  const counts = score(r);
  const exists = state.sections.some(s => s.id === r.section);
  return div("stack session", header(t("Результат проверки", "Free check result"), r.name + (exists ? "" : t(" · раздел удалён", " · section deleted"))),
    div("score boxed pad", ...[["correct", t("Верно", "Correct")], ["missed", t("Ошибки", "Missed")], ["skipped", t("Без оценки", "Ungraded")]]
      .map(([key, label]) => el("span", { class: key === "correct" ? "good" : "" }, el("strong", {}, String(counts[key])), " " + label))),
    div("rows", r.ids.map(id => row(lookup(id).question, r.grades[id] === "good" ? t("Верно", "Correct")
      : r.grades[id] === "miss" ? t("Ошибка", "Missed") : t("Без оценки", "Ungraded")))),
    actions(counts.missed && exists ? primary(l.retry, () => retry(r)) : null,
      button(l.history, () => { state.historyScope = "all"; show("history"); }),
      quiet(t("К практике", "Back to practice"), () => show("home"))));
}

function reviewScreen() {
  const index = state.reviewIndex ?? 0;
  const queue = eligible().slice(0, 2);
  const card = queue[index];
  return div("stack session", header(t("Интервальное повторение", "Spaced repetition"), current().name),
    card ? div("stack", meta((index + 1) + "/" + queue.length), heading(2, card.question),
      state.reviewRevealed ? [answer(card), actions(
        [t("Снова", "Again"), t("Трудно", "Hard"), t("Хорошо", "Good"), t("Легко", "Easy")].map(grade => button(grade, () => {
          state.reviewIndex = index + 1;
          state.reviewRevealed = false;
          render(true);
        })))] : actions(primary(t("Показать ответ", "Reveal answer"), () => { state.reviewRevealed = true; render(true); })))
      : text(t("На сейчас повторений больше нет.", "No more cards due now."), "notice"),
    actions(quiet(t("К практике", "Back to practice"), () => show("practice"))));
}

function restore() {
  modal(t("Восстановление данных", "Recover study data"), text(t("Предпросмотр восстановления из локальной копии.", "Preview recovery from a local copy.")),
    actions(modalCancel(), primary(t("Восстановить учебные данные", "Restore sample study data"), () => {
      state.recovery = false;
      close();
      render(true);
      tell(t("Учебные данные восстановлены", "Sample data restored"));
    })));
}

function render(focus = false) {
  document.documentElement.lang = language;
  document.documentElement.dataset.theme = theme;
  const section = current();
  const page = state.page === "home" ? variant === "C" ? "cards" : "practice" : state.page;
  let view;
  if (state.recovery) {
    view = div("stack", header(t("Требуется восстановление", "Recovery needed")),
      div("notice alert", text(t("Study Cards не смог прочитать учебные данные.", "Study Cards could not read the study data."))),
      actions(primary(t("Открыть восстановление", "Open recovery"), restore)));
  } else if (page === "history") view = historyScreen();
  else if (page === "result") view = report();
  else if (page === "session") view = session();
  else if (page === "enroll") view = enrollment();
  else if (!section) view = empty();
  else if (page === "setup") view = freeCheckSetup();
  else if (page === "cards") view = catalog(section);
  else if (page === "sources") view = sourcesPage(section);
  else if (page === "review") view = reviewScreen();
  else view = practice(section);
  const navigation = !state.recovery && !["enroll", "session", "result", "review"].includes(page);
  workspace.replaceChildren(div("shell " + (variant === "C" ? "catalog-layout" : ""),
    top(), div(variant === "B" && navigation ? "shelf" : "",
      variant === "B" && navigation ? rail() : null,
      navigation ? div("sectionbar", nav(), page === "setup" ? null : sectionMenu()) : null,
      el("main", { class: "body", "aria-labelledby": "view-heading" }, view))));
  lab.replaceChildren(div("lab-inner",
    div("actions",
      quiet(t("Предыдущий вариант", "Previous variant"), () => shiftVariant(-1), { id: "variant-prev", "aria-label": t("Предыдущий вариант", "Previous variant") }, icon("left")),
      el("strong", {}, variant + " · " + names()[variant]),
      quiet(t("Следующий вариант", "Next variant"), () => shiftVariant(1), { id: "variant-next", "aria-label": t("Следующий вариант", "Next variant") }, icon("right"))),
    div("actions", button(t("Сценарий", "Scenario"), chooseScenario),
      button(t("Светлая тема", "Dark theme"), () => {
        theme = theme === "dark" ? "light" : "dark"; updateUrl(); render(); document.querySelector("#theme").focus();
      }, { id: "theme" }),
      button(t("EN", "RU"), () => {
        language = language === "ru" ? "en" : "ru"; updateUrl(); render(); document.querySelector("#language").focus();
      }, { id: "language", "aria-label": t("Переключить на английский", "Switch to Russian") })),
    el("span", { class: "lab-note" }, t("Прототип · учебные данные", "Prototype · sample data"))));
  document.querySelector("#theme").textContent = theme === "dark" ? t("Светлая тема", "Light theme") : t("Тёмная тема", "Dark theme");
  if (focus) document.querySelector("#view-heading")?.focus();
}

document.addEventListener("click", e => {
  const menu = document.querySelector(".menu[open]");
  if (menu && !menu.contains(e.target)) menu.open = false;
});
document.addEventListener("keydown", e => {
  if (dialog.open || e.target.matches("input, textarea, select, [contenteditable]")) return;
  const menu = document.querySelector(".menu[open]");
  if (e.key === "Escape" && menu) {
    menu.open = false;
    menu.querySelector("summary").focus();
  }
  if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    e.preventDefault();
    shiftVariant(e.key === "ArrowLeft" ? -1 : 1);
  }
});
render();
