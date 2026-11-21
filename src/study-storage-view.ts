import { Modal, Notice, Platform, PluginSettingTab, Setting, type App, type Plugin } from "obsidian";
import { localization, t } from "./localization";
import { message } from "./source-modals";
import type { StudyCards } from "./study-cards";
import { StaleStudyState, type ImportPreview, type SnapshotSummary } from "./study-storage";

function summary(root: HTMLElement, version: SnapshotSummary | null) {
  if (!version) {
    root.createEl("p", { text: t("noSavedState") });
    return;
  }
  root.createEl("p", { text: t("snapshotVersionCaption", {
    date: localization.date(version.savedAt), action: localization.snapshotAction(version.action),
  }) });
  if (version.unconfirmed) root.createEl("p", { text: t("unconfirmedWrite") });
  root.createEl("p", { text: version.sections.length ? version.sections.join(", ") : t("noStudySections") });
  root.createEl("p", { text: t("snapshotReviewCounts", { reviews: version.intervalReviews, results: version.freeResults }) });
  const check = version.pendingCheck;
  if (check) root.createEl("p", {
    text: t("snapshotPendingCheck", { check: t(check.retry ? "mistakeRetry" : "unfinishedCheck"),
      answered: check.answered, total: check.total }),
  });
}

async function saveSnapshot(app: App, root: HTMLElement, snapshot: Promise<string>, filename: string) {
  const data = await snapshot;
  if (Platform.isMobile) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = filename.replace(/\.json$/, `-${timestamp}.json`);
    const file = await app.vault.create(path, data);
    new Notice(t("mobileSnapshotSaved", { path: file.path }));
    return;
  }

  const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  const link = root.ownerDocument.createElement("a");
  link.href = url;
  link.download = filename;
  root.ownerDocument.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function renderStudyStorage(app: App, root: HTMLElement, study: StudyCards) {
  const { token, problem, saving } = study.persistence;
  const report = (task: Promise<unknown>) => { void task.catch((error) => new Notice(message(error))); };
  if (saving) root.createEl("p", { text: t("savingStudyData"), attr: { role: "status" } });
  if (problem) {
    const panel = root.createDiv({ cls: "study-cards-item" });
    if (problem.kind === "unsupported") {
      panel.createEl("p", { text: t("unsupportedSnapshotWrite", { version: String(problem.version) }) });
    } else if (problem.kind === "conflict") {
      panel.createEl("p", { text: t("versionConflict") });
      for (const version of problem.versions) {
        const item = panel.createDiv({ cls: "study-cards-item" });
        summary(item, version);
        const select = item.createEl("button", { text: t("useVersion") });
        select.disabled = saving;
        select.onclick = () => report(study.chooseStudyVersion(token, version.id));
      }
      if (problem.canStartEmpty) {
        const start = panel.createEl("button", { text: t("createEmptyState") });
        start.disabled = saving;
        start.onclick = () => new RestoreModal(app, false, () => study.restoreStudyData(token, false)).open();
      }
    } else {
      const reason = {
        missing: "recoveryMissingSharedFile",
        damaged: "recoveryDamagedSharedFile",
        migration: "recoveryInterruptedMigration",
      } as const;
      panel.createEl("p", { text: t(reason[problem.reason]) });
      if (problem.backup) {
        panel.createEl("strong", { text: t("localReadOnlyCopy") });
        summary(panel, problem.backup);
      } else panel.createEl("p", { text: t("noValidLocalCopy") });
      const button = panel.createEl("button", { text: problem.backup ? t("restoreBackup") : t("createEmptyState") });
      const useBackup = Boolean(problem.backup);
      button.disabled = saving;
      button.onclick = () => new RestoreModal(app, useBackup, () => study.restoreStudyData(token, useBackup)).open();
    }
    const refresh = panel.createEl("button", { text: t("checkSharedFile") });
    refresh.onclick = () => report(study.refreshStorage());
  }

  if (problem?.kind === "recovery") renderSnapshotActions(app, root, study);
}

function renderSnapshotActions(app: App, root: HTMLElement, study: StudyCards) {
  const report = (task: Promise<unknown>) => { void task.catch((error) => new Notice(message(error))); };
  const settings = new Setting(root).setName(t("studyCardsData")).setDesc(t("snapshotTransferHint"));
  const picker = settings.settingEl.createEl("input", { type: "file", attr: { accept: ".json,application/json" } });
  picker.hidden = true;
  settings.addButton((button) => button.setButtonText(t("exportSnapshot")).onClick(() =>
    report(saveSnapshot(app, root, study.exportStudyData(), "study-cards.json"))));
  settings.addButton((button) => button.setButtonText(t("importSnapshot")).onClick(() => picker.click()));
  const label = Platform.isMobile ? t("saveBeforeImport") : t("downloadBeforeImport");
  const beforeImport = new Setting(root).setName(label);
  beforeImport.addButton((button) => button.setButtonText(label).onClick(() =>
    report(saveSnapshot(app, root, Promise.resolve(study.exportBeforeImport()), "study-cards-before-import.json"))));
  const [save, load] = settings.controlEl.querySelectorAll<HTMLButtonElement>("button");
  const update = () => {
    const { problem, saving, hasBeforeImport } = study.persistence;
    save!.disabled = saving;
    load!.disabled = saving || problem?.kind === "unsupported" || problem?.kind === "conflict";
    beforeImport.settingEl.hidden = !hasBeforeImport;
  };
  update();
  picker.onchange = () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (file) report(file.text().then(async (raw) => {
      const preview = await study.previewImport(raw);
      new ImportModal(app, study, raw, preview).open();
    }));
  };
  return update;
}

export class StudyCardsSettings extends PluginSettingTab {
  private unsubscribe?: () => void;

  constructor(app: App, plugin: Plugin, private readonly study: StudyCards) { super(app, plugin); }

  display() {
    this.hide();
    this.containerEl.empty();
    const advanced = this.containerEl.createEl("details", { cls: "study-cards-advanced-settings" });
    advanced.createEl("summary", { text: t("advancedStudySettings") });
    const update = renderSnapshotActions(this.app, advanced, this.study);
    this.unsubscribe = this.study.subscribe(update);
  }

  hide() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}

class RestoreModal extends Modal {
  constructor(app: App, private readonly useBackup: boolean, private readonly restore: () => Promise<void>) { super(app); }

  onOpen() {
    this.setTitle(this.useBackup ? t("restoreSharedFilePrompt") : t("createEmptyStatePrompt"));
    this.contentEl.createEl("p", { text: t("restoreSharedFileNotice") });
    confirm(this.contentEl, t("confirm"), async () => {
      await this.restore();
      this.close();
    }, () => this.close());
  }
}

class ImportModal extends Modal {
  constructor(app: App, private readonly study: StudyCards, private readonly raw: string, private preview: ImportPreview) { super(app); }

  onOpen() {
    this.setTitle(t("importPreview"));
    this.render();
  }

  private render(feedback?: string) {
    const root = this.contentEl;
    root.empty();
    root.createEl("h4", { text: t("snapshotDate", { date: localization.date(this.preview.exportedAt) }) });
    summary(root, this.preview.incoming);
    root.createEl("h4", { text: t("currentState") });
    summary(root, this.preview.current);
    root.createEl("p", { text: t("importNotice") });
    if (feedback) root.createEl("p", { text: feedback, attr: { role: "status" } });
    confirm(root, t("replaceSharedData"), async () => {
      try {
        await this.study.importStudyData(this.preview);
        this.close();
      } catch (error) {
        if (!(error instanceof StaleStudyState)) throw error;
        this.preview = await this.study.previewImport(this.raw);
        this.render(t("importPreviewChanged"));
      }
    }, () => this.close());
  }
}

function confirm(root: HTMLElement, label: string, save: () => Promise<void>, cancel?: () => void) {
  const status = root.createEl("p", { attr: { role: "status" } });
  const actions = root.createDiv({ cls: "study-cards-dialog-actions" });
  if (cancel) actions.createEl("button", { text: t("cancel") }).onclick = cancel;
  const button = actions.createEl("button", { text: label, cls: "mod-cta" });
  button.onclick = () => {
    button.disabled = true;
    status.textContent = t("saving");
    void save().then(() => { status.textContent = ""; }).catch((error) => { status.textContent = message(error); }).finally(() => {
      button.disabled = false;
    });
  };
}
