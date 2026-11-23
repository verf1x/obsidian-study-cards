import { Component, FuzzySuggestModal, Modal, Notice, TFile, TFolder, type App, type HoverParent, type TAbstractFile } from "obsidian";
import { t } from "./localization";
import { sameFormat, single, type Format } from "./markdown";
import { renderCardMarkdown } from "./render-markdown";
import { parentFolderPath, remapPath, type EnrollmentPreview, type PreviewRow, type Source, type SourceRequest, type StudyCards } from "./study-cards";

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
  return format.mode === "collection" ? "#".repeat(format.level) : t("wholeNote");
}

export function renderEnrollmentExamples(root: HTMLElement) {
  const examples = root.createDiv({ cls: "study-cards-enrollment-examples" });
  for (const mode of ["singleExample", "collectionExample"] as const) {
    const item = examples.createDiv();
    item.createEl("strong", { text: t(mode) });
    item.createEl("pre").createEl("code", { text: t(mode === "singleExample" ? "singleExampleMarkdown" : "collectionExampleMarkdown") });
  }
}

interface OpenNote {
  kind: SourceRequest["kind"];
  sourcePath: string;
  path: string;
  preview: boolean;
  question: number;
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
  private readonly folderFilter?: HTMLSelectElement;
  private readonly name?: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly count: HTMLElement;
  private readonly feedback: HTMLElement;
  private readonly confirm: HTMLButtonElement;
  private readonly cancel: HTMLButtonElement;
  private readonly unsubscribe: () => void;
  private readonly connectedFiles: Set<string>;
  private opened?: OpenNote;
  private revealSettings = false;
  private answer?: Component;
  private rows: PreviewRow[] = [];
  private pending = new Set<string>();
  private changedChoices = new Set<string>();
  private refreshAll = true;
  private busy = false;
  private planReady = false;
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
    const heading = root.createEl("h2", { text: t(!section ? "newSection" : replaceSource ? "reconnectSource"
      : source ? "configureSource" : "connectNotes"), attr: { tabindex: "-1" } });
    if (!section) {
      const label = root.createEl("label", { cls: "study-cards-form", text: t("sectionName") });
      this.name = label.createEl("input", { type: "text", value: this.suggestName() });
      this.name.oninput = () => this.updateConfirm();
    } else root.createEl("p", { cls: "study-cards-section-context", text: section.name });

    if (!source || replaceSource) {
      const tools = root.createDiv({ cls: "study-cards-controls study-cards-enrollment-tools" });
      if (!source) {
        const filter = () => { this.draw(); this.list.scrollTop = 0; };
        this.search = tools.createEl("input", { type: "search", placeholder: t("findNote"),
          attr: { "aria-label": t("findNote") } });
        this.search.oninput = filter;
        this.folderFilter = tools.createEl("select", { attr: { "aria-label": t("filterNotesByFolder") } });
        this.folderFilter.onchange = filter;
      }
      const add = tools.createEl("button", { text: t(replaceSource ? "chooseNewPath" : "findFolder") });
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
      if (!source) {
        const help = root.createEl("details", { cls: "study-cards-enrollment-help" });
        help.createEl("summary", { text: t("howNotesBecomeCards") });
        const body = help.createDiv();
        renderEnrollmentExamples(body);
        body.createEl("p", { text: t("headingBoundaries") });
      }
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
    this.unsubscribe = watch(({ path, oldPath }) => {
      if (oldPath) {
        this.preview.rename(oldPath, path);
        if (this.opened) {
          this.opened.path = remapPath(this.opened.path, oldPath, path);
          this.opened.sourcePath = remapPath(this.opened.sourcePath, oldPath, path);
        }
        for (const connected of [...this.connectedFiles]) {
          const moved = remapPath(connected, oldPath, path);
          if (moved === connected) continue;
          this.connectedFiles.delete(connected);
          this.connectedFiles.add(moved);
        }
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
    this.clearAnswer();
  }

  private clearAnswer() {
    this.answer?.unload();
    this.answer = undefined;
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
      const rows = await this.preview.refresh(refreshAll ? undefined : affected);
      if (this.closed) return;
      const inPaths = ({ path }: PreviewRow) => [...paths].some((changed) => path === changed || path.startsWith(changed + "/"));
      if (paths.size && JSON.stringify(selected.filter(inPaths)) !== JSON.stringify(rows.filter((row) => row.checked && inPaths(row)))) {
        this.feedback.setText(t("confirmChangedSources", { paths: [...paths].join(", ") }));
      }
      if (refreshAll && !this.rows.length) {
        const first = rows.find((row) => row.checked && (row.needsFormat || this.options.source?.kind === "file"));
        if (first) this.openNote(first, this.preview.sources[first.source]!);
      }
      this.rows = rows;
      this.planReady = true;
      this.updateFolderFilter();
      this.draw();
    } catch (error) {
      if (this.closed) return;
      this.planReady = false;
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

  private updateFolderFilter() {
    const filter = this.folderFilter;
    if (!filter) return;
    const selected = filter.value;
    const paths = [...new Set(this.rows.map(({ path }) => parentFolderPath(path)))].sort((a, b) => a.localeCompare(b));
    filter.empty();
    filter.createEl("option", { value: "", text: t("allFolders") });
    for (const path of paths) filter.createEl("option", { value: path || "/", text: pathName(path) });
    filter.value = selected && paths.includes(selected === "/" ? "" : selected) ? selected : "";
  }

  private draw() {
    const focused = this.list.querySelector<HTMLElement>(":focus")?.dataset.focus;
    const scroll = this.list.scrollTop;
    this.clearAnswer();
    this.list.empty();
    const query = this.search?.value.trim().toLocaleLowerCase() ?? "";
    const folder = this.folderFilter?.value;
    const matches = (path: string) => path.toLocaleLowerCase().includes(query)
      && (!folder || (parentFolderPath(path) || "/") === folder);
    const groups = new Map<number, PreviewRow[]>();
    for (const row of this.rows) {
      const items = groups.get(row.source) ?? [];
      items.push(row);
      groups.set(row.source, items);
    }
    this.preview.sources.forEach((request, index) => {
      const rows = groups.get(index) ?? [];
      if (request.kind === "folder") {
        this.drawFolder(request, rows.filter(({ path }) => matches(path)), index);
      } else if (matches(request.path)) {
        for (const row of rows) this.drawNote(this.list, row, request);
      }
    });
    if (!this.list.childElementCount) this.list.createEl("p", { text: t("noMatchingNotes") });
    this.list.scrollTop = scroll;
    if (this.revealSettings) {
      this.revealSettings = false;
      const settings = this.list.querySelector(".study-cards-enrollment-settings");
      if (settings) {
        const list = this.list.getBoundingClientRect();
        const { top, bottom } = settings.getBoundingClientRect();
        if (top < list.top) this.list.scrollTop += top - list.top;
        else if (bottom > list.bottom) this.list.scrollTop += Math.min(top - list.top, bottom - list.bottom);
      }
    }
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
    if (!rows.length) group.createEl("p", { text: t(this.search?.value.trim() || this.folderFilter?.value
      ? "noMatchingNotes" : "folderWithoutNotes") });
    for (const row of rows) this.drawNote(group, row, source);
  }

  private drawNote(root: HTMLElement, row: PreviewRow, source: SourceRequest) {
    const item = root.createDiv({ cls: "study-cards-enrollment-note" });
    const summary = item.createDiv({ cls: "study-cards-enrollment-row" });
    const label = summary.createEl("label", { attr: { title: row.path } });
    const key = JSON.stringify([source.kind, source.path, row.path]);
    const opened = this.opened;
    const isOpen = opened?.kind === source.kind && opened.sourcePath === source.path && opened.path === row.path;
    const check = label.createEl("input", { type: "checkbox", attr: { "aria-label": row.path, "data-focus": key } });
    check.checked = row.checked;
    check.onchange = () => {
      this.preview.choose(row.source, row.path, { checked: check.checked });
      if (check.checked) this.openNote(row, source);
      else if (isOpen) this.opened = undefined;
      this.edit(row.path);
    };
    label.createSpan({ text: row.path.split("/").pop() });
    if (!row.checked) return;
    const caption = row.cards.length ? `${formatName(row.format)} · ${t("sectionCardCount", { count: row.cards.length })}` : t("configure");
    const expand = summary.createEl("button", { text: caption, cls: "study-cards-quiet-button",
      attr: { "aria-expanded": String(isOpen), "aria-label": t("noteSettings", { path: row.path, status: caption }),
        "data-focus": "settings:" + key } });
    expand.onclick = () => {
      if (isOpen) this.opened = undefined;
      else this.openNote(row, source);
      this.draw();
    };
    if (row.dirty || row.error || row.unavailableLevel !== undefined) {
      item.createEl("p", { cls: "study-cards-enrollment-warning",
        text: row.error ?? (row.dirty ? t("waitingForEditor")
          : t("unavailableHeadingLevel", { heading: "#".repeat(row.unavailableLevel!) })) });
    }
    if (isOpen && !row.error) this.drawSettings(item, row, opened, key);
  }

  private openNote(row: PreviewRow, source: SourceRequest) {
    this.opened = { kind: source.kind, sourcePath: source.path, path: row.path, preview: false, question: 0 };
    this.revealSettings = true;
  }

  private drawSettings(item: HTMLElement, row: PreviewRow, opened: OpenNote, key: string) {
    const root = item.createDiv({ cls: "study-cards-enrollment-settings" });
    if (row.needsFormat) {
      root.createEl("p", { text: t("chooseNoteFormat") });
    }
    const formats = root.createDiv({ cls: "study-cards-controls", attr: { role: "group", "aria-label": t("sourceFormat") } });
    const selected = !row.needsFormat;
    const whole = selected && row.format.mode === "single";
    const choose = (format: Format) => {
      if (selected && sameFormat(row.format, format)) return;
      opened.question = 0;
      this.preview.choose(row.source, row.path, { format });
      this.edit(row.path);
    };
    const option = (text: string, choice: Format, active: boolean, id: string) => {
      const control = formats.createEl("button", { text, cls: active ? "mod-cta" : undefined,
        attr: { "aria-pressed": String(active), "data-focus": id + ":" + key } });
      control.onclick = () => choose(choice);
    };
    option(t("wholeNote"), whole ? row.format : single, whole, "whole");
    for (const { level, count } of row.headingOptions) {
      const choice = { mode: "collection", level } as const;
      option(`${formatName(choice)} · ${t("sectionCardCount", { count })}`, choice,
        selected && sameFormat(row.format, choice), "level-" + level);
    }
    if (whole && row.hasFirstHeading) {
      const label = root.createEl("label", { cls: "study-cards-source-choice" });
      const filename = label.createEl("input", { type: "checkbox", attr: { "data-focus": "filename:" + key } });
      filename.checked = row.format.mode === "single" && row.format.question === "filename";
      label.appendText(t("useFilenameQuestion"));
      filename.onchange = () => choose({ mode: "single", question: filename.checked ? "filename" : "heading" });
    }
    if (!row.cards.length) return;
    const toggle = root.createEl("button", { text: t("preview"), cls: "study-cards-quiet-button",
      attr: { "aria-expanded": String(opened.preview), "data-focus": "preview:" + key } });
    const preview = root.createDiv({ cls: "study-cards-enrollment-preview" });
    const show = () => {
      toggle.setAttribute("aria-expanded", String(opened.preview));
      preview.hidden = !opened.preview;
      if (opened.preview) this.drawPreview(preview, row, opened, key);
      else {
        this.clearAnswer();
        preview.empty();
      }
    };
    toggle.onclick = () => {
      opened.preview = !opened.preview;
      show();
    };
    show();
  }

  private drawPreview(root: HTMLElement, row: PreviewRow, opened: OpenNote, key: string) {
    const picker = row.cards.length > 1
      ? root.createEl("label", { cls: "study-cards-preview-question", text: t("previewQuestion") })
        .createEl("select", { attr: { "data-focus": "question:" + key } })
      : undefined;
    const card = root.createDiv({ cls: "study-cards-enrollment-card" });
    const showAnswer = () => {
      this.clearAnswer();
      card.empty();
      const { question, answer, firstLine, lastLine } = row.cards[opened.question] ?? row.cards[0]!;
      card.createEl("strong", { text: question });
      card.createEl("small", { text: t("previewLines", { first: firstLine, last: lastLine }) });
      const body = card.createDiv();
      const owner = this.answer = new Component();
      owner.load();
      this.registerPreviewLinks(body, row.path, owner);
      void renderCardMarkdown(this.app, body, answer, row.path, owner).catch(() => {
        if (this.answer === owner) body.setText(answer);
      });
    };
    opened.question = Math.min(opened.question, row.cards.length - 1);
    if (picker) {
      row.cards.forEach(({ question }, index) => picker.createEl("option", { value: String(index), text: question }));
      picker.value = String(opened.question);
      picker.onchange = () => {
        opened.question = Number(picker.value);
        showAnswer();
      };
    }
    showAnswer();
  }

  private registerPreviewLinks(body: HTMLElement, sourcePath: string, owner: Component) {
    const hoverParent: HoverParent = { hoverPopover: null };
    const linkTarget = (event: MouseEvent) =>
      (event.target as Element | null)?.closest?.<HTMLElement>("a.internal-link[data-href]");
    owner.registerDomEvent(body, "click", (event) => {
      const linktext = linkTarget(event)?.dataset.href;
      if (!linktext || event.defaultPrevented) return;
      event.preventDefault();
      void this.app.workspace.openLinkText(linktext, sourcePath, "tab").catch((error) => new Notice(message(error)));
    });
    owner.registerDomEvent(body, "mouseover", (event) => {
      const targetEl = linkTarget(event);
      const linktext = targetEl?.dataset.href;
      if (linktext && !targetEl?.contains(event.relatedTarget as Node | null)) {
        this.app.workspace.trigger("hover-link", { event, source: "preview", hoverParent, targetEl, linktext, sourcePath });
      }
    });
    owner.register(() => hoverParent.hoverPopover?.unload());
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
    const { cards, needsFormat, blocked } = this.preview.selection;
    const count = t("enrollmentSelectionCount", { cards: t("sectionCardCount", { count: cards }) });
    this.count.setText(needsFormat ? `${count} · ${t("notesToConfigure", { count: needsFormat })}` : count);
    const folders = this.requests.filter(({ kind }) => kind === "folder");
    this.confirm.disabled = !this.planReady || this.busy || this.saving || Boolean(this.name && !this.name.value.trim())
      || blocked
      || folders.some(({ path }) => path !== "" && !(this.app.vault.getAbstractFileByPath(path) instanceof TFolder))
      || (!cards && !folders.length);
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
