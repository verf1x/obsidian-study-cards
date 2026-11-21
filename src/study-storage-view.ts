import { Modal, Notice, type App } from "obsidian";
import { message } from "./source-modals";
import type { StudyCards } from "./study-cards";
import { StaleStudyState, type ImportPreview, type SnapshotSummary } from "./study-storage";

const date = (value: string) => new Date(value).toLocaleString();

function summary(root: HTMLElement, version: SnapshotSummary | null) {
  if (!version) {
    root.createEl("p", { text: "Нет сохранённого состояния." });
    return;
  }
  root.createEl("p", { text: date(version.savedAt) + " · " + version.action });
  root.createEl("p", { text: version.sections.length ? version.sections.join(", ") : "Нет учебных разделов" });
  root.createEl("p", { text: `Интервальных оценок · ${version.intervalReviews}. Результатов свободной проверки · ${version.freeResults}.` });
  const check = version.pendingCheck;
  if (check) root.createEl("p", {
    text: `${check.retry ? "Повтор ошибок" : "Незавершённая проверка"} · оценено ${check.answered} из ${check.total}`,
  });
}

async function download(root: HTMLElement, snapshot: Promise<string>, filename: string) {
  const url = URL.createObjectURL(new Blob([await snapshot], { type: "application/json" }));
  const link = root.ownerDocument.createElement("a");
  link.href = url;
  link.download = filename;
  root.ownerDocument.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function renderStudyStorage(app: App, root: HTMLElement, study: StudyCards, opened: Set<string | null>) {
  const { token, problem, saving, hasBeforeImport } = study.persistence;
  const report = (task: Promise<unknown>) => { void task.catch((error) => new Notice(message(error))); };
  if (saving) root.createEl("p", { text: "Сохранение данных Study Cards…", attr: { role: "status" } });
  if (problem) {
    const panel = root.createDiv({ cls: "study-cards-item" });
    if (problem.kind === "unsupported") {
      panel.createEl("p", { text: `Формат Study Cards ${problem.version} требует совместимой версии плагина. Запись заблокирована.` });
    } else if (problem.kind === "conflict") {
      panel.createEl("p", { text: "Версии Study Cards разошлись. Выберите рабочую версию, чтобы продолжить запись." });
      for (const version of problem.versions) {
        const item = panel.createDiv({ cls: "study-cards-item" });
        summary(item, version);
        const select = item.createEl("button", { text: "Использовать эту версию" });
        select.disabled = saving;
        select.onclick = () => report(study.chooseStudyVersion(token, version.id));
      }
    } else {
      const reason = {
        missing: "Общий файл Study Cards отсутствует.",
        damaged: "Общий файл Study Cards повреждён. Доступный экземпляр сохранён на устройстве.",
        migration: "Перенос данных в общий файл Study Cards прерван.",
      }[problem.reason];
      panel.createEl("p", { text: reason + " Дождитесь синхронизации, импортируйте снимок или восстановите состояние." });
      if (problem.backup) {
        panel.createEl("strong", { text: "Локальная копия для просмотра" });
        summary(panel, problem.backup);
      } else panel.createEl("p", { text: "Исправная локальная копия отсутствует." });
      const button = panel.createEl("button", { text: problem.backup ? "Восстановить копию" : "Создать пустое состояние" });
      const useBackup = Boolean(problem.backup);
      button.disabled = saving;
      button.onclick = () => new RestoreModal(app, useBackup, () => study.restoreStudyData(token, useBackup)).open();
    }
    const refresh = panel.createEl("button", { text: "Проверить общий файл" });
    refresh.onclick = () => report(study.refreshStorage());
  }

  const tools = root.createEl("details", { attr: { "data-card": "study-storage" } });
  tools.open = opened.has("study-storage") || (problem?.kind === "recovery" && !saving);
  tools.createEl("summary", { text: "Данные Study Cards" });
  const controls = tools.createDiv({ cls: "study-cards-controls" });
  const save = controls.createEl("button", { text: "Экспортировать снимок" });
  save.disabled = saving;
  save.onclick = () => report(download(root, study.exportStudyData(), "study-cards.json"));
  if (hasBeforeImport) {
    controls.createEl("button", { text: "Скачать копию до импорта" }).onclick =
      () => report(download(root, Promise.resolve(study.exportBeforeImport()), "study-cards-before-import.json"));
  }
  const picker = controls.createEl("input", { type: "file", attr: { accept: ".json,application/json" } });
  picker.hidden = true;
  const load = controls.createEl("button", { text: "Импортировать снимок" });
  load.disabled = saving || problem?.kind === "unsupported" || problem?.kind === "conflict";
  load.onclick = () => picker.click();
  picker.onchange = () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (file) report(file.text().then(async (raw) => {
      const preview = await study.previewImport(raw);
      new ImportModal(app, study, raw, preview).open();
    }));
  };
}

class RestoreModal extends Modal {
  constructor(app: App, private readonly useBackup: boolean, private readonly restore: () => Promise<void>) { super(app); }

  onOpen() {
    this.setTitle(this.useBackup ? "Восстановить общий файл?" : "Создать пустое состояние?");
    this.contentEl.createEl("p", { text: "Подтверждение запишет общий файл, который получат другие устройства после синхронизации." });
    confirm(this.contentEl, "Подтвердить", async () => {
      await this.restore();
      this.close();
    }, () => this.close());
  }
}

class ImportModal extends Modal {
  constructor(app: App, private readonly study: StudyCards, private readonly raw: string, private preview: ImportPreview) { super(app); }

  onOpen() {
    this.setTitle("Предпросмотр импорта Study Cards");
    this.render();
  }

  private render(feedback?: string) {
    const root = this.contentEl;
    root.empty();
    root.createEl("h4", { text: "Снимок от " + date(this.preview.exportedAt) });
    summary(root, this.preview.incoming);
    root.createEl("h4", { text: "Текущее состояние" });
    summary(root, this.preview.current);
    root.createEl("p", { text: "Импорт заменит общие данные. Копия до импорта сохранится на этом устройстве." });
    if (feedback) root.createEl("p", { text: feedback, attr: { role: "status" } });
    confirm(root, "Заменить общие данные", async () => {
      try {
        await this.study.importStudyData(this.preview);
        this.close();
      } catch (error) {
        if (!(error instanceof StaleStudyState)) throw error;
        this.preview = await this.study.previewImport(this.raw);
        this.render("Общие данные изменились. Проверьте обновлённую сводку и подтвердите импорт.");
      }
    }, () => this.close());
  }
}

function confirm(root: HTMLElement, label: string, save: () => Promise<void>, cancel?: () => void) {
  const status = root.createEl("p", { attr: { role: "status" } });
  const actions = root.createDiv({ cls: "study-cards-dialog-actions" });
  if (cancel) actions.createEl("button", { text: "Отмена" }).onclick = cancel;
  const button = actions.createEl("button", { text: label, cls: "mod-cta" });
  button.onclick = () => {
    button.disabled = true;
    status.textContent = "Сохранение…";
    void save().catch((error) => { status.textContent = message(error); }).finally(() => {
      button.disabled = false;
      if (status.textContent === "Сохранение…") status.textContent = "";
    });
  };
}
