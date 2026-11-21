import { Component, FuzzySuggestModal, MarkdownRenderer, Modal, Notice, TFile, TFolder, type App, type TAbstractFile } from "obsidian";
import { t } from "./localization";
import { single, type Format } from "./markdown";
import { remapPath, type EnrollmentPreview, type PreviewRow, type Source, type SourceRequest, type StudyCards } from "./study-cards";

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
  };
  mode.onchange = level.onchange = question.onchange = () => {
    update();
    onChange(levelLabel.hidden
      ? { mode: "single", question: question.value === "filename" ? "filename" : "heading" }
      : { mode: "collection", level: Number(level.value) });
  };
  update();
}

interface EnrollmentOptions {
  section?: { id: string; name: string };
  initial: SourceRequest[];
  source?: Source;
  replaceSource?: boolean;
  onConnected: () => void;
  onCancel: () => void;
}

export class SourceEnrollment {
  private readonly preview: EnrollmentPreview;
  private readonly requests: SourceRequest[];
  private readonly search?: HTMLInputElement;
  private readonly name?: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly count: HTMLElement;
  private readonly feedback: HTMLElement;
  private readonly confirm: HTMLButtonElement;
  private readonly cancel: HTMLButtonElement;
  private readonly unsubscribe: () => void;
  private readonly expanded = new Set<string>();
  private readonly connectedFiles: Set<string>;
  private markdown = new Component();
  private rows: PreviewRow[] = [];
  private pending = new Set<string>();
  private changedChoices = new Set<string>();
  private refreshAll = true;
  private busy = false;
  private saving = false;
  private closed = false;

  constructor(private readonly app: App, private readonly root: HTMLElement, study: StudyCards, watch: WatchVault,
    private readonly options: EnrollmentOptions) {
    this.requests = options.initial.map((request) => ({ ...request }));
    const { section, source, replaceSource } = options;
    this.connectedFiles = new Set(study.sections.find(({ id }) => id === section?.id)?.sources
      .filter(({ kind }) => kind === "file").map(({ path }) => path));
    const candidates = this.noteCandidates();
    const requests = [...this.requests, ...candidates];
    this.preview = section ? study.preview(section.id, requests, source?.id) : study.previewNewSection(requests);
    this.excludeCandidates(candidates);
    this.markdown.load();
    const heading = root.createEl("h2", { text: t(!section ? "newSection" : replaceSource ? "reconnectSource"
      : source ? "configureSource" : "connectNotes"), attr: { tabindex: "-1" } });
    if (!section) {
      const label = root.createEl("label", { cls: "study-cards-form", text: t("sectionName") });
      this.name = label.createEl("input", { type: "text", value: this.suggestName() });
      this.name.oninput = () => this.updateConfirm();
    } else root.createEl("p", { cls: "study-cards-section-context", text: section.name });

    if (!source) {
      this.search = root.createEl("input", { type: "search", placeholder: t("findNote"),
        attr: { "aria-label": t("findNote") } });
      this.search.oninput = () => { this.draw(); this.list.scrollTop = 0; };
    }
    this.list = root.createDiv({ cls: "study-cards-enrollment-notes", attr: { tabindex: "0", role: "region",
      "aria-label": t("notes") } });
    this.feedback = root.createEl("p", { attr: { role: "status" } });
    const footer = root.createDiv({ cls: "study-cards-enrollment-actions" });
    this.count = footer.createEl("small", { attr: { role: "status" } });
    const actions = footer.createDiv({ cls: "study-cards-controls" });
    this.confirm = actions.createEl("button", { cls: "mod-cta", text: t(!section ? "connectAndCreateSection"
      : source && !replaceSource ? "save" : "connectNotes") });
    this.confirm.onclick = () => { void this.submit(); };
    this.cancel = actions.createEl("button", { text: t("cancel"), cls: "study-cards-quiet-button" });
    this.cancel.onclick = options.onCancel;
    if (!source || replaceSource) {
      const add = root.createEl("button", { cls: "study-cards-quiet-button", text: t(replaceSource ? "chooseNewPath" : "findFolder") });
      add.onclick = () => {
        if (this.saving) return;
        picker(app, source?.kind ?? "folder", (request) => {
          if (this.closed || this.saving) return;
          if (source) this.requests.splice(0, 1, { ...source, ...request });
          else if (!this.requests.some(({ kind, path }) => kind === request.kind && path === request.path)) this.requests.push(request);
          this.refreshAll = true;
          void this.refresh();
        });
      };
    }
    this.unsubscribe = watch(({ path, oldPath }) => {
      if (oldPath) {
        this.preview.rename(oldPath, path);
        if (this.connectedFiles.delete(oldPath)) this.connectedFiles.add(path);
        for (const request of this.requests) request.path = remapPath(request.path, oldPath, path);
        this.pending.add(oldPath);
      }
      this.pending.add(path);
      void this.refresh();
    });
    void this.refresh();
    heading.focus();
  }

  get confirming() { return this.saving; }

  close() {
    this.closed = true;
    this.unsubscribe();
    this.markdown.unload();
  }

  private suggestName() {
    if (this.requests.length !== 1) return t("suggestedSectionName");
    return this.requests[0]!.path.split("/").pop()?.replace(/\.md$/i, "") || t("suggestedSectionName");
  }

  private noteCandidates() {
    if (this.options.source) return [];
    const initial = new Set(this.requests.filter(({ kind }) => kind === "file").map(({ path }) => path));
    return this.app.vault.getMarkdownFiles()
      .filter(({ path }) => !initial.has(path) && !this.connectedFiles.has(path))
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(({ path }): SourceRequest => ({ kind: "file", path }));
  }

  private excludeCandidates(candidates: SourceRequest[], previous = new Set<string>()) {
    candidates.forEach(({ path }, index) => {
      if (!previous.has(path)) this.preview.choose(this.requests.length + index, path, { checked: false });
    });
  }

  private async refresh() {
    if (this.closed || this.busy || this.saving) return;
    this.busy = true;
    this.updateConfirm();
    const paths = new Set(this.pending);
    const affected = new Set([...paths, ...this.changedChoices]);
    this.pending.clear();
    this.changedChoices.clear();
    const refreshAll = this.refreshAll;
    this.refreshAll = false;
    try {
      const candidates = this.noteCandidates();
      const requests = [...this.requests, ...candidates];
      const previous = new Set(this.preview.sources.map(({ path }) => path));
      const changed = requests.length !== this.preview.sources.length
        || requests.some((request, index) => JSON.stringify(request) !== JSON.stringify(this.preview.sources[index]));
      if (changed) {
        this.preview.replaceSources(requests);
        this.excludeCandidates(candidates, previous);
      }
      const selected = this.rows.filter(({ checked }) => checked);
      const rows = await this.preview.refresh(refreshAll || changed ? undefined : affected);
      if (this.closed) return;
      const inPaths = ({ path }: PreviewRow) => [...paths].some((changed) => path === changed || path.startsWith(changed + "/"));
      if (paths.size && JSON.stringify(selected.filter(inPaths)) !== JSON.stringify(rows.filter((row) => row.checked && inPaths(row)))) {
        this.feedback.setText(t("confirmChangedSources", { paths: [...paths].join(", ") }));
      }
      this.rows = rows;
      this.draw();
    } catch (error) {
      this.rows = [];
      this.feedback.setText(message(error));
      this.draw();
    } finally {
      this.busy = false;
      this.updateConfirm();
      if (this.refreshAll || this.pending.size || this.changedChoices.size) void this.refresh();
    }
  }

  private edit(path?: string) {
    if (path === undefined) this.refreshAll = true;
    else this.changedChoices.add(path);
    this.feedback.setText("");
    void this.refresh();
  }

  private draw() {
    const focused = this.list.querySelector<HTMLElement>(":focus")?.dataset.focus;
    const scroll = this.list.scrollTop;
    this.markdown.unload();
    this.markdown = new Component();
    this.markdown.load();
    this.list.empty();
    const query = this.search?.value.trim().toLocaleLowerCase() ?? "";
    const groups = new Map<number, PreviewRow[]>();
    for (const row of this.rows) {
      const items = groups.get(row.source) ?? [];
      items.push(row);
      groups.set(row.source, items);
    }
    this.preview.sources.forEach((request, index) => {
      const rows = groups.get(index) ?? [];
      if (request.kind === "folder") {
        this.drawFolder(request, rows, index);
      } else if (request.path.toLocaleLowerCase().includes(query)) {
        for (const row of rows) this.drawNote(this.list, row, request);
      }
    });
    if (!this.list.childElementCount) this.list.createEl("p", { text: t("noMatchingNotes") });
    this.list.scrollTop = scroll;
    if (focused) this.list.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  private drawFolder(source: SourceRequest & { kind: "folder" }, rows: PreviewRow[], index: number) {
    const group = this.list.createDiv({ cls: "study-cards-enrollment-folder" });
    const header = group.createDiv({ cls: "study-cards-controls" });
    header.createEl("strong", { text: pathName(source.path) });
    if (!this.options.source) {
      header.createEl("button", { text: t("remove"), attr: { "aria-label": t("removeNamedSource", { path: pathName(source.path) }) } })
        .onclick = () => {
          this.requests.splice(index, 1);
          this.edit();
        };
    }
    const label = group.createEl("label", { cls: "study-cards-source-choice" });
    const recursive = label.createEl("input", { type: "checkbox" });
    label.appendText(t("includeSubfolders"));
    recursive.checked = source.recursive ?? false;
    recursive.onchange = () => {
      const request = this.requests[index];
      if (request?.kind === "folder") request.recursive = recursive.checked;
      this.edit();
    };
    formatFields(group, source.format ?? single, (format) => this.changeFormat(source, format));
    if (!rows.length) group.createEl("p", { text: t("folderWithoutNotes") });
    for (const row of rows) this.drawNote(group, row, source);
  }

  private drawNote(root: HTMLElement, row: PreviewRow, source: SourceRequest) {
    const item = root.createDiv({ cls: "study-cards-enrollment-note" });
    const summary = item.createDiv({ cls: "study-cards-enrollment-row" });
    const label = summary.createEl("label");
    const key = `${source.kind}:${source.path}:${row.path}`;
    const check = label.createEl("input", { type: "checkbox", attr: { "data-focus": key } });
    check.checked = row.checked;
    check.onchange = () => {
      this.preview.choose(row.source, row.path, { checked: check.checked });
      this.edit(row.path);
    };
    const caption = label.createSpan();
    caption.createSpan({ text: row.path });
    caption.createEl("small", { text: t("sectionCardCount", { count: row.cards.length }) });
    const expand = summary.createEl("button", { text: t("preview"), cls: "study-cards-quiet-button",
      attr: { "aria-label": t("previewNamedNote", { path: row.path }), "data-focus": "preview:" + key } });
    const detail = item.createDiv({ cls: "study-cards-enrollment-preview" });
    let loaded = false;
    const show = (visible: boolean) => {
      if (visible && !loaded) {
        loaded = true;
        this.drawPreview(detail, row, source);
      }
      detail.hidden = !visible;
      expand.setAttribute("aria-expanded", String(visible));
    };
    show(this.expanded.has(key));
    expand.onclick = () => {
      if (this.expanded.has(key)) this.expanded.delete(key);
      else this.expanded.add(key);
      show(this.expanded.has(key));
    };
    if (row.checked && (row.dirty || row.error || row.needsFormat || !row.cards.length)) {
      item.createEl("p", { cls: "study-cards-enrollment-warning",
        text: row.error ?? (row.dirty ? t("waitingForEditor") : row.needsFormat ? t("selectFormatInPreview") : t("noNoteQuestions")) });
    }
  }

  private drawPreview(root: HTMLElement, row: PreviewRow, source: SourceRequest) {
    if (row.needsFormat) {
      const select = root.createEl("label", { text: t("chooseFormatPrompt") + " " }).createEl("select");
      select.createEl("option", { value: "", text: t("chooseFormat") }).disabled = true;
      row.formats.forEach((format, index) => select.createEl("option", { value: String(index), text: formatName(format) }));
      select.onchange = () => {
        this.preview.choose(row.source, row.path, { format: row.formats[Number(select.value)] });
        this.edit(row.path);
      };
    } else if (source.kind === "file") {
      formatFields(root, source.format ?? row.format, (format) => this.changeFormat(source, format));
    }
    for (const { question, answer, firstLine, lastLine } of row.cards) {
      const card = root.createDiv({ cls: "study-cards-enrollment-card" });
      card.createEl("strong", { text: question });
      card.createEl("small", { text: t("previewLines", { first: firstLine, last: lastLine }) });
      const body = card.createDiv({ cls: "study-cards-markdown" });
      void MarkdownRenderer.render(this.app, answer, body, row.path, this.markdown)
        .catch(() => { body.setText(answer); });
    }
  }

  private changeFormat(source: SourceRequest, format: Format) {
    const request = this.requests.find(({ kind, path }) => kind === source.kind && path === source.path);
    if (request) request.format = format;
    else {
      this.requests.push({ ...source, format });
    }
    this.edit();
  }

  private updateConfirm() {
    const checked = this.rows.filter(({ checked }) => checked);
    const counts = new Map(checked.map(({ path, cards }) => [path, cards.length]));
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    this.count.setText(t("enrollmentSelectionCount", { cards: t("sectionCardCount", { count: total }) }));
    const folders = this.requests.filter(({ kind }) => kind === "folder");
    this.confirm.disabled = this.busy || this.saving || Boolean(this.name && !this.name.value.trim())
      || checked.some((row) => row.dirty || row.error || row.needsFormat || !row.cards.length)
      || folders.some(({ path }) => path !== "" && !(this.app.vault.getAbstractFileByPath(path) instanceof TFolder))
      || (!total && !folders.length);
    this.cancel.disabled = this.saving;
    this.list.inert = this.saving;
  }

  private async submit() {
    if (this.confirm.disabled) return;
    this.saving = true;
    this.updateConfirm();
    try {
      const result = await this.preview.confirm(this.name?.value);
      if (result.confirmed) {
        this.options.onConnected();
        return;
      }
      this.feedback.setText(t("confirmChangedSources", { paths: result.paths.join(", ") }));
    } catch (error) {
      this.feedback.setText(message(error));
    } finally {
      this.saving = false;
    }
    this.refreshAll = true;
    await this.refresh();
  }
}

export class ManageSourceModal extends Modal {
  private enrollment?: SourceEnrollment;
  constructor(app: App, private readonly study: StudyCards, private readonly watch: WatchVault,
    private readonly section: { id: string; name: string }, private readonly source: Source,
    private readonly replaceSource = false) { super(app); }

  onOpen() {
    this.contentEl.addClass("study-cards-enrollment");
    this.enrollment = new SourceEnrollment(this.app, this.contentEl, this.study, this.watch, {
      section: this.section, source: this.source, replaceSource: this.replaceSource,
      initial: this.replaceSource ? [] : [this.source], onConnected: () => super.close(), onCancel: () => this.close(),
    });
  }

  close() { if (!this.enrollment?.confirming) super.close(); }

  onClose() { this.enrollment?.close(); }
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
