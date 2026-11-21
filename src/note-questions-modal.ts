import { FuzzySuggestModal, Modal, Notice, type App, type TFile } from "obsidian";
import { t } from "./localization";
import { message } from "./source-modals";
import type { Source, StudyCards } from "./study-cards";

type NoteQuestions = NonNullable<ReturnType<StudyCards["noteQuestions"]>>;

export function configureNoteQuestions(app: App, study: StudyCards, sectionId: string, source: Source) {
  const open = (path: string) => {
    const file = app.vault.getFileByPath(path);
    const settings = study.noteQuestions(sectionId, path);
    if (!file || !settings) {
      new Notice(t("noteQuestionsUnavailable"));
      return;
    }
    new NoteQuestionsModal(app, study, sectionId, file, settings).open();
  };
  if (source.kind === "file") {
    open(source.path);
    return;
  }

  const notes = study.connectedNotes(sectionId, source.id);
  if (!notes.length) {
    new Notice(t("noConfigurableNotes"));
    return;
  }
  class ConnectedNotePicker extends FuzzySuggestModal<string> {
    getItems() { return notes; }
    getItemText(path: string) { return path; }
    onChooseItem(path: string) { open(path); }
  }
  const picker = new ConnectedNotePicker(app);
  picker.setPlaceholder(t("findConnectedNote"));
  picker.open();
}

class NoteQuestionsModal extends Modal {
  constructor(app: App, private readonly study: StudyCards, private readonly sectionId: string,
    private readonly file: TFile, private readonly settings: NoteQuestions) {
    super(app);
  }

  onOpen() {
    const { cards, cardIds } = this.settings;
    const allIds = cards.flatMap(({ id }) => id === null ? [] : [id]);
    let selection = cardIds === null ? null : new Set(cardIds);
    this.setTitle(t("configureQuestions"));
    this.contentEl.addClass("study-cards-question-settings");
    this.contentEl.createEl("p", { text: this.file.path });

    const options = this.contentEl.createDiv({ cls: "study-cards-controls study-cards-question-options" });
    const wholeLabel = options.createEl("label", { cls: "study-cards-question-choice" });
    const whole = wholeLabel.createEl("input", { type: "checkbox" });
    wholeLabel.createSpan({ text: t("includeWholeNote") });
    const clear = options.createEl("button", { text: t("clearQuestionSelection") });
    this.contentEl.createEl("p", { text: t("includeWholeNoteHint"), cls: "study-cards-question-hint" });

    const count = this.contentEl.createEl("p", { attr: { role: "status" } });
    const list = this.contentEl.createDiv({ cls: "study-cards-question-list" });
    const choices = cards.map(({ id, question }) => {
      const label = list.createEl("label", { cls: "study-cards-question-choice" });
      const checkbox = label.createEl("input", { type: "checkbox" });
      label.createSpan({ text: question });
      checkbox.onchange = () => {
        if (id === null) return;
        selection ??= new Set(allIds);
        if (checkbox.checked) selection.add(id);
        else selection.delete(id);
        refresh();
      };
      return { id, checkbox };
    });
    if (!cards.length) list.createEl("p", { text: t("noNoteQuestions") });
    if (allIds.length < cards.length) this.contentEl.createEl("p", { text: t("questionsWithoutIds") });

    const feedback = this.contentEl.createDiv({ attr: { role: "alert" } });
    const actions = this.contentEl.createDiv({ cls: "study-cards-controls study-cards-question-actions" });
    const cancel = actions.createEl("button", { text: t("cancel") });
    const save = actions.createEl("button", { text: t("save"), cls: "mod-cta" });
    let saving = false;
    function refresh() {
      whole.checked = selection === null;
      whole.disabled = clear.disabled = cancel.disabled = save.disabled = saving;
      let selected = 0;
      for (const { id, checkbox } of choices) {
        checkbox.disabled = saving || id === null;
        checkbox.checked = selection === null || (id !== null && selection.has(id));
        if (checkbox.checked) selected++;
      }
      count.textContent = t("questionSelectionCount", { selected, total: cards.length });
    }
    whole.onchange = () => {
      selection = whole.checked ? null : new Set();
      refresh();
    };
    clear.onclick = () => {
      selection = new Set();
      refresh();
    };
    cancel.onclick = () => this.close();
    save.onclick = async () => {
      saving = true;
      feedback.empty();
      refresh();
      try {
        await this.study.setNoteQuestions(this.sectionId, this.file.path, selection === null ? null : [...selection], cardIds);
        this.close();
      } catch (error) {
        feedback.textContent = message(error);
      } finally {
        saving = false;
        refresh();
      }
    };
    refresh();
  }
}
