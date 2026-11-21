import { FuzzySuggestModal, Modal, Notice, TFile, TFolder, type App, type TAbstractFile } from "obsidian";
import { t } from "./localization";
import { single, type Format } from "./markdown";
import { remapPath, type EnrollmentPreview, type PreviewRow, type Source, type SourceRequest, type StudyCards } from "./study-cards";

export type VaultChange = { path: string; oldPath?: string };
export type WatchVault = (listener: (change: VaultChange) => void) => () => void;

type FirstConnection = {
  container: HTMLElement;
  onConnected: () => void;
  onCancel: () => void;
  onConfirmSettled: () => void;
};

export function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function sourceRequest(file: TAbstractFile): SourceRequest | undefined {
  if (file instanceof TFolder) return { kind: "folder", path: file.isRoot() ? "" : file.path };
  if (file instanceof TFile && file.extension.toLowerCase() === "md") return { kind: "file", path: file.path };
}

function pathName(path: string) {
  return path || t("vaultRoot");
}

function picker(app: App, kind: SourceRequest["kind"] | undefined, select: (source: SourceRequest) => void) {
  class Picker extends FuzzySuggestModal<SourceRequest> {
    getItems() {
      const files = [app.vault.getRoot(), ...app.vault.getAllLoadedFiles()];
      const items = files.flatMap((file) => sourceRequest(file) ?? []);
      return [...new Map(items.filter((item) => !kind || item.kind === kind)
        .map((item) => [item.path, item])).values()];
    }
    getItemText(item: SourceRequest) { return pathName(item.path); }
    onChooseItem(item: SourceRequest) { select(item); }
  }
  const modal = new Picker(app);
  modal.setPlaceholder(kind === "folder" ? t("findFolder") : kind === "file" ? t("findNote") : t("findFileOrFolder"));
  modal.open();
}

function formatName(format: Format) {
  if (format.mode === "collection") return t("collectionFormat", { level: format.level });
  return format.question === "filename" ? t("singleByFilename") : t("singleByHeading");
}

function formatFields(root: HTMLElement, initial: Format, onChange: (format: Format) => void) {
  const row = root.createDiv({ cls: "study-cards-controls" });
  const mode = row.createEl("label", { text: t("sourceFormat") + " " }).createEl("select");
  mode.createEl("option", { value: "single", text: t("oneCard") });
  mode.createEl("option", { value: "collection", text: t("collection") });
  mode.value = initial.mode;
  const levelLabel = row.createEl("label", { text: t("headingLevel") + " " });
  const level = levelLabel.createEl("select");
  for (let index = 1; index <= 6; index++) level.createEl("option", { value: String(index), text: "H" + index });
  level.value = String(initial.mode === "collection" ? initial.level : 2);
  const questionLabel = row.createEl("label", { text: t("questionFrom") + " " });
  const question = questionLabel.createEl("select");
  question.createEl("option", { value: "heading", text: t("firstH1") });
  question.createEl("option", { value: "filename", text: t("filenameOption") });
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
  private previousPreview?: EnrollmentPreview;
  private unsubscribe?: () => void;
  private sectionName?: string;
  private noteQuery = "";
  private previewModal?: PreviewModal;
  private refreshNoteChoices?: (change: VaultChange) => void;

  constructor(app: App, private readonly study: StudyCards, private readonly watch: WatchVault,
    private readonly section: string | FirstConnection, initial: SourceRequest[], private readonly lockSelection = false,
    private readonly replacement?: Source) {
    super(app);
    this.requests = initial.map((request) => ({ ...request }));
  }

  open() {
    if (typeof this.section === "string") super.open();
    else this.onOpen();
  }

  close() {
    if (typeof this.section === "string") super.close();
    else this.onClose();
  }

  get confirming() { return this.previewModal?.confirming ?? false; }

  closeFlow() {
    this.previewModal?.close();
    this.close();
  }

  onOpen() {
    if (typeof this.section === "string") {
      this.setTitle(this.replacement ? t("reconnectSource") : this.lockSelection ? t("configureSource") : t("addSources"));
      this.contentEl.addClass("study-cards-source-modal");
    } else {
      this.removeUnavailableRequests();
    }
    this.unsubscribe = this.watch((change) => {
      const { path, oldPath } = change;
      let changed = false;
      if (oldPath) {
        this.previousPreview?.rename(oldPath, path);
        for (const request of this.requests) {
          const nextPath = remapPath(request.path, oldPath, path);
          if (nextPath === request.path) continue;
          request.path = nextPath;
          changed = true;
        }
      }
      if (typeof this.section !== "string" && (oldPath || !this.app.vault.getAbstractFileByPath(path))) {
        changed = this.removeUnavailableRequests() || changed;
      }
      if (changed) {
        const restoreFocus = typeof this.section !== "string" && this.section.container.contains(this.section.container.doc.activeElement);
        this.render(restoreFocus ? "pick" : undefined);
      } else {
        this.refreshNoteChoices?.(change);
      }
    });
    this.render(this.requests.length ? "preview" : "pick");
  }

  onClose() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.refreshNoteChoices = undefined;
  }

  private removeUnavailableRequests() {
    const present = this.requests.filter(({ path, kind }) => {
      const file = path ? this.app.vault.getAbstractFileByPath(path) : this.app.vault.getRoot();
      return file && sourceRequest(file)?.kind === kind;
    });
    if (present.length === this.requests.length) return false;
    this.requests.splice(0, this.requests.length, ...present);
    return true;
  }

  private render(focus?: "pick" | "preview", currentNote?: string) {
    const first = typeof this.section === "string" ? undefined : this.section;
    const root = first?.container ?? this.contentEl;
    const scroll = root.querySelector(".study-cards-enrollment-notes")?.scrollTop ?? 0;
    root.empty();
    if (first) {
      root.createEl("h2", { text: t("chooseNotesForStudy") });
      this.renderNoteChoices(root, scroll, focus === "pick", currentNote);
    }
    for (const [index, source] of this.requests.entries()) {
      const item = root.createDiv({ cls: "study-cards-item" });
      const headline = item.createDiv({ cls: "study-cards-controls" });
      headline.createEl("strong", { text: pathName(source.path) });
      if (!this.lockSelection && !this.replacement && (!first || source.kind === "folder")) {
        const remove = headline.createEl("button", { text: t("remove"), attr: { "aria-label": t("removeNamedSource", { path: pathName(source.path) }) } });
        remove.onclick = () => {
          this.requests.splice(index, 1);
          this.render("pick");
        };
      }
      if (source.kind === "folder") {
        const label = item.createEl("label", { cls: "study-cards-source-choice" });
        const check = label.createEl("input", { type: "checkbox" });
        label.appendText(" " + t("includeSubfolders"));
        check.checked = source.recursive ?? false;
        check.onchange = () => { source.recursive = check.checked; };
      }
      formatFields(item, source.format ?? single, (format) => { source.format = format; });
    }
    const actions = root.createDiv({ cls: first ? "study-cards-controls study-cards-enrollment-actions" : "study-cards-controls" });
    if (!this.lockSelection) {
      const pick = actions.createEl("button", {
        text: this.replacement ? t("chooseNewPath") : first ? t("findFolder") : t("chooseFileOrFolder"),
        cls: !first && !this.requests.length ? "mod-cta" : undefined,
      });
      pick.onclick = () => picker(this.app, first ? "folder" : this.replacement?.kind, (source) => {
        if (this.replacement) this.requests.splice(0, 1, { ...this.replacement, ...source });
        else if (!this.requests.some(({ path, kind }) => path === source.path && kind === source.kind)) this.requests.push(source);
        this.render(this.replacement ? "preview" : "pick");
      });
      if (focus === "pick" && !first) pick.focus();
    }
    if (first) {
      actions.createEl("button", { text: t("cancel"), cls: "study-cards-quiet-button" }).onclick = first.onCancel;
    }
    if (!this.requests.length && !first) return;
    const next = actions.createEl("button", { text: t("preview"), cls: "mod-cta" });
    next.disabled = !this.requests.length;
    next.onclick = () => {
      try {
        const target = this.section;
        const preview = this.previousPreview ?? (typeof target === "string"
          ? this.study.preview(target, this.requests, this.replacement?.id)
          : this.study.previewFirstSection(this.requests));
        if (this.previousPreview) preview.replaceSources(this.requests);
        const first = typeof target !== "string" ? {
          ...target,
          name: this.sectionName ?? this.suggestSectionName(),
          onNameChange: (name: string) => { this.sectionName = name; },
        } : undefined;
        const confirm = first ? t("connectAndCreateSection") : this.lockSelection ? t("save") : t("connect");
        const modal = new PreviewModal(this.app, this.watch, preview, confirm, () => {
          this.previewModal = undefined;
          this.previousPreview = preview;
          this.requests.splice(0, this.requests.length, ...preview.sources.map((source) => ({ ...source })));
          this.open();
        }, first);
        this.close();
        this.previewModal = modal;
        modal.open();
      } catch (error) {
        new Notice(message(error));
      }
    };
    if (focus === "preview") next.focus();
  }

  private renderNoteChoices(root: HTMLElement, scroll: number, focusSearch: boolean, currentNote?: string) {
    const search = root.createEl("input", { type: "search", value: this.noteQuery, placeholder: t("findNote"),
      attr: { "aria-label": t("findNote") } });
    const list = root.createDiv({ cls: "study-cards-enrollment-notes", attr: { role: "group", "aria-label": t("notes") } });
    const notePaths = () => this.app.vault.getMarkdownFiles().map(({ path }) => path).sort((a, b) => a.localeCompare(b));
    let files = notePaths();
    const draw = (focus?: string) => {
      list.empty();
      const query = this.noteQuery.trim().toLocaleLowerCase();
      const selected = new Set(this.requests.filter(({ kind }) => kind === "file").map(({ path }) => path));
      for (const path of files) {
        if (!path.toLocaleLowerCase().includes(query)) continue;
        const label = list.createEl("label", { cls: "study-cards-picker-option" });
        const check = label.createEl("input", { type: "checkbox", attr: { "data-note-path": path } });
        check.checked = selected.has(path);
        label.createSpan({ text: path });
        check.onchange = () => {
          if (check.checked) this.requests.push({ kind: "file", path });
          else {
            const index = this.requests.findIndex((request) => request.kind === "file" && request.path === path);
            if (index >= 0) this.requests.splice(index, 1);
          }
          this.render(undefined, path);
        };
        if (path === focus) check.focus({ preventScroll: true });
      }
      if (!list.childElementCount) list.createEl("p", { text: t("noMatchingNotes") });
    };
    search.oninput = () => {
      this.noteQuery = search.value;
      draw();
      list.scrollTop = 0;
    };
    this.refreshNoteChoices = ({ path, oldPath }) => {
      if (!oldPath && files.includes(path) === (this.app.vault.getFileByPath(path)?.extension.toLowerCase() === "md")
        && !files.some((known) => known.startsWith(path + "/"))) return;
      const focus = list.querySelector<HTMLInputElement>("input:focus")?.dataset.notePath;
      const top = list.scrollTop;
      files = notePaths();
      draw(focus);
      list.scrollTop = top;
      if (focus && !list.contains(list.doc.activeElement)) search.focus();
    };
    draw(currentNote);
    list.scrollTop = scroll;
    if (focusSearch) search.focus();
  }

  private suggestSectionName() {
    if (this.requests.length !== 1) return t("suggestedSectionName");
    const { path, kind } = this.requests[0]!;
    const name = path.slice(path.lastIndexOf("/") + 1);
    return (kind === "file" ? name.replace(/\.md$/i, "") : name) || t("suggestedSectionName");
  }
}

class PreviewModal extends Modal {
  private unsubscribe?: () => void;
  private list!: HTMLElement;
  private feedback!: HTMLElement;
  private confirm!: HTMLButtonElement;
  private backButton!: HTMLButtonElement;
  private name?: HTMLInputElement;
  private total?: HTMLElement;
  private rows?: PreviewRow[];
  private eligible = false;
  private pending = new Set<string>();
  private sourceChanged = false;
  private refreshAll = true;
  private busy = false;
  private openNow = false;
  confirming = false;

  constructor(app: App, private readonly watch: WatchVault, private readonly preview: EnrollmentPreview,
    private readonly confirmLabel: string, private readonly goBack: () => void,
    private readonly first?: FirstConnection & { name: string; onNameChange: (name: string) => void }) {
    super(app);
  }

  open() { if (this.first) this.onOpen(); else super.open(); }
  close() { if (this.first) this.onClose(); else super.close(); }

  onOpen() {
    this.openNow = true;
    const root = this.first?.container ?? this.contentEl;
    if (this.first) {
      root.empty();
      root.createEl("h2", { text: t("enrollmentPreview") });
    } else {
      this.setTitle(t("enrollmentPreview"));
      root.addClass("study-cards-source-modal");
    }
    if (this.first) {
      const label = root.createEl("label", { cls: "study-cards-form", text: t("studySection") });
      this.name = label.createEl("input", { type: "text", value: this.first.name });
      this.name.required = true;
      this.name.oninput = () => {
        this.first?.onNameChange(this.name!.value);
        this.updateConfirm();
      };
      this.name.focus();
      this.total = root.createEl("p", { attr: { "aria-live": "polite" } });
    }
    root.createEl("p", { text: t("enrollmentNotice") });
    this.list = root.createDiv({
      cls: "study-cards-source-review",
      attr: { tabindex: "0", role: "region", "aria-label": t("enrollmentPreview") },
    });
    this.feedback = root.createEl("p", { attr: { role: "status" } });
    const actions = root.createDiv({ cls: "study-cards-dialog-actions" });
    this.backButton = actions.createEl("button", { text: t("back") });
    this.backButton.onclick = () => {
      this.close();
      this.goBack();
    };
    if (this.first) actions.createEl("button", { text: t("cancel") }).onclick = this.first.onCancel;
    this.confirm = actions.createEl("button", { text: this.confirmLabel, cls: "mod-cta" });
    this.confirm.onclick = () => { void this.submit(); };
    this.unsubscribe = this.watch(({ path, oldPath }) => {
      if (oldPath) {
        this.preview.rename(oldPath, path);
        this.pending.add(oldPath);
      }
      this.pending.add(path);
      this.sourceChanged = true;
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
    this.confirm.disabled = this.backButton.disabled = true;
    const paths = this.refreshAll ? undefined : new Set(this.pending);
    const sourceChanged = this.sourceChanged;
    this.sourceChanged = false;
    this.pending.clear();
    this.refreshAll = false;
    try {
      const rows = await this.preview.refresh(paths);
      if (this.openNow) {
        if (this.first && sourceChanged && paths && this.rows) {
          const previous = this.rows.filter(({ checked }) => checked);
          const current = rows.filter(({ checked }) => checked);
          if (JSON.stringify(previous) !== JSON.stringify(current)) {
            this.feedback.textContent = t("confirmChangedSources", { paths: [...paths].join(", ") });
          }
        }
        this.rows = rows;
        this.render(rows);
      }
    } catch (error) {
      this.eligible = false;
      this.feedback.textContent = message(error);
    } finally {
      this.busy = false;
      this.backButton.disabled = false;
      this.updateConfirm();
      if (this.refreshAll || this.pending.size) void this.refresh();
    }
  }

  private async submit() {
    if (this.confirm.disabled) return;
    this.confirming = this.busy = this.confirm.disabled = true;
    this.backButton.disabled = true;
    try {
      const result = await this.preview.confirm(this.name?.value);
      if (result.confirmed) {
        this.close();
        this.first?.onConnected();
        return;
      }
      this.feedback.textContent = t("confirmChangedSources", { paths: result.paths.join(", ") });
    } catch (error) {
      this.feedback.textContent = message(error);
    } finally {
      this.confirming = this.busy = false;
      this.first?.onConfirmSettled();
      this.backButton.disabled = false;
      this.refreshAll = true;
      await this.refresh();
    }
  }

  private render(rows: PreviewRow[]) {
    if (this.total) {
      const counts = new Map(rows.filter(({ checked }) => checked).map(({ path, cards }) => [path, cards.length]));
      this.total.textContent = t("cardCount", { count: [...counts.values()].reduce((total, count) => total + count, 0) });
    }
    const expanded = new Set([...this.list.querySelectorAll("details[open]")].map((item) => item.getAttribute("data-row")));
    const focused = this.list.querySelector(":focus")?.getAttribute("data-focus");
    this.list.empty();
    for (const [index, source] of this.preview.sources.entries()) {
      const group = this.list.createDiv({ cls: "study-cards-item" });
      const items = rows.filter((row) => row.source === index);
      if (source.kind === "folder" || !items.length) group.createEl("h4", { text: pathName(source.path) });
      if (!items.length) group.createEl("p", { text: source.kind === "folder" ? t("folderWithoutNotes") : t("missingNote") });
      for (const row of items) {
        const item = group.createDiv({ cls: source.kind === "folder" ? "study-cards-item" : undefined });
        const label = item.createEl("label", { cls: "study-cards-source-choice" });
        const key = String(index) + ":" + row.path;
        const check = label.createEl("input", { type: "checkbox", attr: { "data-focus": key } });
        if (focused === key) check.focus();
        check.checked = row.checked;
        label.appendText(" " + t("previewNoteCount", { path: row.path, count: row.cards.length }));
        check.onchange = () => {
          this.preview.choose(index, row.path, { checked: check.checked });
          this.pending.add(row.path);
          void this.refresh();
        };
        if (row.dirty) item.createEl("p", { text: t("waitingForEditor") });
        if (row.error) item.createEl("p", { text: row.error });
        if (row.needsFormat) {
          const select = item.createEl("label", { text: t("chooseFormatPrompt") + " " }).createEl("select");
          select.createEl("option", { value: "", text: t("chooseFormat") }).disabled = true;
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
          cards.createEl("li", { text: t("previewQuestionLine", { first: firstLine, last: lastLine, question }) });
        });
      }
    }
    this.eligible = !rows.some((row) => row.checked && (row.dirty || row.error || row.needsFormat))
      && (this.preview.sources.some(({ kind }) => kind === "folder") || rows.some(({ checked }) => checked));
  }

  private updateConfirm() {
    this.confirm.disabled = this.busy || !this.eligible || Boolean(this.name && !this.name.value.trim());
  }
}

export class CreateCardModal extends Modal {
  constructor(app: App, private readonly study: StudyCards, private readonly section: string,
    private readonly openNote: (path: string) => Promise<void>) {
    super(app);
  }

  onOpen() {
    this.setTitle(t("createCard"));
    const root = this.contentEl;
    root.addClass("study-cards-form-modal");
    const form = root.createEl("form", { cls: "study-cards-form" });
    const name = form.createEl("label", { text: t("fileName") + " " }).createEl("input", { type: "text" });
    name.required = true;
    name.focus();
    let folder = "";
    let format = single;
    const destination = form.createDiv({ cls: "study-cards-controls" });
    destination.createSpan({ text: t("folder") });
    const folderButton = destination.createEl("button", { type: "button", text: pathName(folder) });
    folderButton.onclick = () => picker(this.app, "folder", (item) => {
      folder = item.path;
      folderButton.textContent = pathName(folder);
    });
    formatFields(form, format, (value) => { format = value; });
    const label = form.createEl("label");
    const template = label.createEl("input", { type: "checkbox" });
    template.checked = true;
    label.appendText(" " + t("addCardTemplate"));
    const feedback = form.createEl("p", { attr: { role: "status" } });
    const submit = form.createEl("button", { text: t("createAndOpen"), cls: "mod-cta", type: "submit" });
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
