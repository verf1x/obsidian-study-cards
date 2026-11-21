import { FuzzySuggestModal, Modal, Notice, TFile, TFolder, type App, type TAbstractFile } from "obsidian";
import { single, type Format } from "./markdown";
import { type EnrollmentPreview, type PreviewRow, type SourceRequest, type StudyCards } from "./study-cards";

export type VaultChange = { path: string; oldPath?: string };
export type WatchVault = (listener: (change: VaultChange) => void) => () => void;

export function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function sourceRequest(file: TAbstractFile): SourceRequest | undefined {
  if (file instanceof TFolder) return { kind: "folder", path: file.isRoot() ? "" : file.path };
  if (file instanceof TFile && file.extension.toLowerCase() === "md") return { kind: "file", path: file.path };
}

function pathName(path: string) {
  return path || "Корень хранилища";
}

function picker(app: App, foldersOnly: boolean, select: (source: SourceRequest) => void) {
  class Picker extends FuzzySuggestModal<SourceRequest> {
    getItems() {
      const files = [app.vault.getRoot(), ...app.vault.getAllLoadedFiles()];
      const items = files.flatMap((file) => sourceRequest(file) ?? []);
      return [...new Map(items.filter((item) => !foldersOnly || item.kind === "folder")
        .map((item) => [item.path, item])).values()];
    }
    getItemText(item: SourceRequest) { return pathName(item.path); }
    onChooseItem(item: SourceRequest) { select(item); }
  }
  const modal = new Picker(app);
  modal.setPlaceholder(foldersOnly ? "Найти папку" : "Найти файл или папку");
  modal.open();
}

function formatName(format: Format) {
  if (format.mode === "collection") return "Коллекция · H" + format.level;
  return format.question === "filename" ? "Одна карточка · имя файла" : "Одна карточка · первый H1";
}

function formatFields(root: HTMLElement, initial: Format, onChange: (format: Format) => void) {
  const row = root.createDiv({ cls: "study-cards-controls" });
  const mode = row.createEl("label", { text: "Формат " }).createEl("select");
  mode.createEl("option", { value: "single", text: "Одна карточка" });
  mode.createEl("option", { value: "collection", text: "Коллекция" });
  mode.value = initial.mode;
  const levelLabel = row.createEl("label", { text: "Уровень " });
  const level = levelLabel.createEl("select");
  for (let index = 1; index <= 6; index++) level.createEl("option", { value: String(index), text: "H" + index });
  level.value = String(initial.mode === "collection" ? initial.level : 2);
  const questionLabel = row.createEl("label", { text: "Вопрос из " });
  const question = questionLabel.createEl("select");
  question.createEl("option", { value: "heading", text: "первого H1" });
  question.createEl("option", { value: "filename", text: "имени файла" });
  question.value = initial.mode === "single" ? initial.question : "heading";
  const update = () => {
    levelLabel.hidden = mode.value !== "collection";
    questionLabel.hidden = !levelLabel.hidden;
    onChange(levelLabel.hidden
      ? { mode: "single", question: question.value === "filename" ? "filename" : "heading" }
      : { mode: "collection", level: Number(level.value) });
  };
  mode.onchange = level.onchange = question.onchange = update;
  update();
}

export class SelectSourcesModal extends Modal {
  private readonly requests: SourceRequest[];

  constructor(app: App, private readonly study: StudyCards, private readonly watch: WatchVault,
    private readonly section: string, initial: SourceRequest[], private readonly lockSelection = false) {
    super(app);
    this.requests = initial.map((request) => ({ ...request }));
  }

  onOpen() {
    this.setTitle(this.lockSelection ? "Настроить источник" : "Добавить источники");
    this.contentEl.addClass("study-cards-source-modal");
    this.render();
  }

  private render() {
    this.contentEl.empty();
    for (const [index, source] of this.requests.entries()) {
      const item = this.contentEl.createDiv({ cls: "study-cards-item" });
      const headline = item.createDiv({ cls: "study-cards-controls" });
      headline.createEl("strong", { text: pathName(source.path) });
      if (!this.lockSelection) {
        const remove = headline.createEl("button", { text: "Убрать", attr: { "aria-label": "Убрать " + pathName(source.path) } });
        remove.onclick = () => {
          this.requests.splice(index, 1);
          this.render();
        };
      }
      if (source.kind === "folder") {
        const label = item.createEl("label", { cls: "study-cards-source-choice" });
        const check = label.createEl("input", { type: "checkbox" });
        label.appendText(" Включить подпапки");
        check.checked = source.recursive ?? false;
        check.onchange = () => { source.recursive = check.checked; };
      }
      formatFields(item, source.format ?? single, (format) => { source.format = format; });
    }
    const actions = this.contentEl.createDiv({ cls: "study-cards-controls" });
    if (!this.lockSelection) {
      const pick = actions.createEl("button", {
        text: "Выбрать файл или папку", cls: this.requests.length ? undefined : "mod-cta",
      });
      pick.onclick = () => picker(this.app, false, (source) => {
        if (!this.requests.some(({ path, kind }) => path === source.path && kind === source.kind)) this.requests.push(source);
        this.render();
      });
    }
    if (!this.requests.length) return;
    const next = actions.createEl("button", { text: "Предпросмотр", cls: "mod-cta" });
    next.onclick = () => {
      try {
        this.close();
        new PreviewModal(this.app, this.study, this.watch, this.section, this.requests,
          this.lockSelection ? "Сохранить" : "Подключить", () => this.open()).open();
      } catch (error) {
        new Notice(message(error));
        this.open();
      }
    };
  }
}

class PreviewModal extends Modal {
  private readonly preview: EnrollmentPreview;
  private unsubscribe?: () => void;
  private list!: HTMLElement;
  private feedback!: HTMLElement;
  private confirm!: HTMLButtonElement;
  private backButton!: HTMLButtonElement;
  private pending = new Set<string>();
  private refreshAll = true;
  private busy = false;
  private openNow = false;

  constructor(app: App, study: StudyCards, private readonly watch: WatchVault, section: string,
    sources: SourceRequest[], private readonly confirmLabel: string, private readonly goBack: () => void) {
    super(app);
    this.preview = study.preview(section, sources);
  }

  onOpen() {
    this.openNow = true;
    this.setTitle("Предпросмотр подключения");
    this.contentEl.addClass("study-cards-source-modal");
    this.contentEl.createEl("p", { text: "Study Cards добавит в выбранные заметки служебные свойства и недостающие UUID." });
    this.list = this.contentEl.createDiv({ cls: "study-cards-source-review" });
    this.feedback = this.contentEl.createEl("p", { attr: { role: "status" } });
    const actions = this.contentEl.createDiv({ cls: "study-cards-dialog-actions" });
    this.backButton = actions.createEl("button", { text: "Назад" });
    this.backButton.onclick = () => {
      this.close();
      this.goBack();
    };
    this.confirm = actions.createEl("button", { text: this.confirmLabel, cls: "mod-cta" });
    this.confirm.onclick = () => { void this.submit(); };
    this.unsubscribe = this.watch(({ path, oldPath }) => {
      if (oldPath) {
        this.preview.rename(oldPath, path);
        this.pending.add(oldPath);
      }
      this.pending.add(path);
      void this.refresh();
    });
    void this.refresh();
  }

  onClose() {
    this.openNow = false;
    this.unsubscribe?.();
  }

  private async refresh() {
    if (this.busy || !this.openNow) return;
    this.busy = true;
    this.confirm.disabled = true;
    const paths = this.refreshAll ? undefined : new Set(this.pending);
    this.pending.clear();
    this.refreshAll = false;
    try {
      const rows = await this.preview.refresh(paths);
      if (this.openNow) this.render(rows);
    } catch (error) {
      this.feedback.textContent = message(error);
    } finally {
      this.busy = false;
      if (this.refreshAll || this.pending.size) void this.refresh();
    }
  }

  private async submit() {
    if (this.busy) return;
    this.busy = this.confirm.disabled = true;
    this.backButton.disabled = true;
    try {
      const result = await this.preview.confirm();
      if (result.confirmed) {
        this.close();
        return;
      }
      this.feedback.textContent = "Заметки изменились. Проверьте список и подтвердите ещё раз: " + result.paths.join(", ");
    } catch (error) {
      this.feedback.textContent = message(error);
    } finally {
      this.busy = false;
      this.backButton.disabled = false;
      this.refreshAll = true;
      await this.refresh();
    }
  }

  private render(rows: PreviewRow[]) {
    const expanded = new Set([...this.list.querySelectorAll("details[open]")].map((item) => item.getAttribute("data-row")));
    const focused = this.list.querySelector(":focus")?.getAttribute("data-focus");
    this.list.empty();
    for (const [index, source] of this.preview.sources.entries()) {
      const group = this.list.createDiv({ cls: "study-cards-item" });
      const items = rows.filter((row) => row.source === index);
      if (source.kind === "folder" || !items.length) group.createEl("h4", { text: pathName(source.path) });
      if (!items.length) group.createEl("p", { text: source.kind === "folder" ? "В папке пока нет Markdown-заметок" : "Заметка не найдена" });
      for (const row of items) {
        const item = group.createDiv({ cls: source.kind === "folder" ? "study-cards-item" : undefined });
        const label = item.createEl("label", { cls: "study-cards-source-choice" });
        const key = String(index) + ":" + row.path;
        const check = label.createEl("input", { type: "checkbox", attr: { "data-focus": key } });
        if (focused === key) check.focus();
        check.checked = row.checked;
        label.appendText(" " + row.path + " · " + row.cards.length);
        check.onchange = () => {
          this.preview.choose(index, row.path, { checked: check.checked });
          this.pending.add(row.path);
          void this.refresh();
        };
        if (row.dirty) item.createEl("p", { text: "Ожидает сохранения в редакторе" });
        if (row.error) item.createEl("p", { text: row.error });
        if (row.needsFormat) {
          const select = item.createEl("label", { text: "Источники задают разные форматы. Выберите формат заметки " }).createEl("select");
          select.createEl("option", { value: "", text: "Выберите формат" }).disabled = true;
          row.formats.forEach((format, choice) => select.createEl("option", { value: String(choice), text: formatName(format) }));
          select.onchange = () => {
            this.preview.choose(index, row.path, { format: row.formats[Number(select.value)] });
            this.pending.add(row.path);
            void this.refresh();
          };
        }
        const details = item.createEl("details", { attr: { "data-row": key } });
        details.open = expanded.has(key);
        details.createEl("summary", { text: formatName(row.format) });
        const cards = details.createEl("ul");
        row.cards.forEach(({ question, firstLine, lastLine }) => {
          cards.createEl("li", { text: firstLine + "–" + lastLine + " · " + question });
        });
      }
    }
    this.confirm.disabled = rows.some((row) => row.checked && (row.dirty || row.error || row.needsFormat))
      || (!this.preview.sources.some(({ kind }) => kind === "folder") && !rows.some(({ checked }) => checked));
  }
}

export class CreateCardModal extends Modal {
  constructor(app: App, private readonly study: StudyCards, private readonly section: string,
    private readonly openNote: (path: string) => Promise<void>) {
    super(app);
  }

  onOpen() {
    this.setTitle("Создать карточку");
    const root = this.contentEl;
    root.addClass("study-cards-form-modal");
    const form = root.createEl("form", { cls: "study-cards-form" });
    const name = form.createEl("label", { text: "Имя файла " }).createEl("input", { type: "text" });
    name.required = true;
    name.focus();
    let folder = "";
    let format = single;
    const destination = form.createDiv({ cls: "study-cards-controls" });
    destination.createSpan({ text: "Папка" });
    const folderButton = destination.createEl("button", { type: "button", text: pathName(folder) });
    folderButton.onclick = () => picker(this.app, true, (item) => {
      folder = item.path;
      folderButton.textContent = pathName(folder);
    });
    formatFields(form, format, (value) => { format = value; });
    const label = form.createEl("label");
    const template = label.createEl("input", { type: "checkbox" });
    template.checked = true;
    label.appendText(" Добавить заготовку вопроса и ответа");
    const feedback = form.createEl("p", { attr: { role: "status" } });
    const submit = form.createEl("button", { text: "Создать и открыть", cls: "mod-cta", type: "submit" });
    form.onsubmit = (event) => {
      event.preventDefault();
      submit.disabled = true;
      void this.study.createCard(this.section, name.value, folder, format, template.checked).then(async (path) => {
        this.close();
        await this.openNote(path);
      }).catch((error) => {
        feedback.textContent = message(error);
        submit.disabled = false;
        if (!this.containerEl.isConnected) new Notice(message(error));
      });
    };
  }
}
