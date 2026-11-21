import { getLanguage, Notice, Plugin, TFile, TFolder, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import { setInterfaceLanguage, t } from "./localization";
import { obsidianStudyStorage } from "./obsidian-study-storage";
import { sharedStudyPath, StudyStorage } from "./study-storage";
import { studyVault } from "./obsidian-vault";
import { message, sourceRequest, type VaultChange, type WatchVault } from "./source-modals";
import { StudyCards, type SourceRequest } from "./study-cards";
import { StudyCardsSettings } from "./study-storage-view";
import { StudyView, viewType } from "./study-view";

export default class StudyCardsPlugin extends Plugin {
  private study!: StudyCards;
  private readonly listeners = new Set<(change: VaultChange) => void>();
  private stopped = false;

  private watch: WatchVault = (listener) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  async onload() {
    setInterfaceLanguage(getLanguage());
    const id = () => globalThis.crypto.randomUUID();
    const io = await obsidianStudyStorage(this.app, (close) => this.register(close));
    const storage = await StudyStorage.open(io, await this.loadData(), id);
    this.study = new StudyCards(studyVault(this.app), storage, id);
    const settings = new StudyCardsSettings(this.app, this, this.study);
    this.addSettingTab(settings);
    this.register(() => settings.hide());
    this.registerView(viewType, (leaf) => this.createView(leaf, this.study, this.watch, this.openNote));
    this.addRibbonIcon("book-open", "Study Cards", () => this.perform(this.showView()));
    this.addCommand({ id: "open-study-cards", name: t("openStudyCards"), callback: () => this.perform(this.showView()) });
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      const request = sourceRequest(file);
      if (request) menu.addItem((item) => item.setTitle(t("addToStudyCards")).setIcon("book-open")
        .onClick(() => this.perform(this.addSources([request]))));
    }));
    this.registerEvent(this.app.workspace.on("files-menu", (menu, files) => {
      const requests = files.flatMap((file) => sourceRequest(file) ?? []);
      if (requests.length) menu.addItem((item) => item.setTitle(t("addToStudyCards")).setIcon("book-open")
        .onClick(() => this.perform(this.addSources(requests))));
    }));

    this.app.workspace.onLayoutReady(() => {
      if (this.stopped) return;
      const refresh = () => this.perform(this.study.refreshStorage());
      const update = (file: TAbstractFile) => {
        if (file.path === sharedStudyPath) refresh();
        if (file instanceof TFile && file.extension.toLowerCase() === "md") {
          this.changed({ path: file.path }, this.study.update(file.path));
        }
      };
      this.registerEvent(this.app.vault.on("create", (file) => {
        if (file instanceof TFolder) this.changed({ path: file.path }, this.study.refreshSources());
        else update(file);
      }));
      this.registerEvent(this.app.vault.on("modify", update));
      this.registerEvent(this.app.metadataCache.on("changed", update));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
        if ([file.path, oldPath].some((path) => path === sharedStudyPath || sharedStudyPath.startsWith(path + "/"))) refresh();
        else this.changed({ path: file.path, oldPath }, this.study.rename(oldPath, file.path));
      }));
      this.registerEvent(this.app.vault.on("delete", (file) => {
        if (file.path === sharedStudyPath || sharedStudyPath.startsWith(file.path + "/")) refresh();
        else this.changed({ path: file.path }, this.study.delete(file.path));
      }));
      this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
        if (info.file) this.notify({ path: info.file.path });
      }));
      this.registerDomEvent(window, "focus", refresh);
      this.registerInterval(window.setInterval(() => {
        if (!document.hidden) refresh();
      }, 5000));
      this.perform(this.study.scan());
    });
    this.register(() => { this.stopped = true; });
  }

  protected createView(leaf: WorkspaceLeaf, study: StudyCards, watch: WatchVault, openNote: (path: string) => Promise<void>) {
    return new StudyView(leaf, study, watch, openNote);
  }

  private changed(change: VaultChange, update: Promise<unknown>) {
    this.perform(update.finally(() => this.notify(change)));
  }

  private notify(change: VaultChange) {
    if (!this.stopped) for (const listener of this.listeners) listener(change);
  }

  private async showView() {
    let leaf = this.app.workspace.getLeavesOfType(viewType)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: viewType, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  private async addSources(requests: SourceRequest[]) {
    const { view } = await this.showView();
    if (view instanceof StudyView) view.connectNotes(requests);
  }

  private openNote = async (path: string) => {
    const file = this.app.vault.getFileByPath(path);
    if (!file) throw new Error(t("missingNoteAt", { path }));
    await this.app.workspace.getLeaf("tab").openFile(file, { active: true, state: { mode: "source" } });
  };

  private perform(task: Promise<unknown>) {
    void task.catch((error) => new Notice(message(error)));
  }
}
