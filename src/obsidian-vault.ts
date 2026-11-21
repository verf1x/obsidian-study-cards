import { MarkdownView, type App } from "obsidian";
import { t } from "./localization";
import type { StudyVault } from "./study-cards";

export function studyVault(app: App): StudyVault {
  const fileAt = (path: string) => {
    const file = app.vault.getFileByPath(path);
    if (!file || file.extension.toLowerCase() !== "md") throw new Error(t("missingNoteAt", { path }));
    return file;
  };
  const assertFileStillAt = (file: ReturnType<typeof fileAt>, path: string) => {
    if (file.path !== path || app.vault.getFileByPath(path) !== file) throw new Error(t("movedNote", { path }));
  };

  return {
    markdownFiles: () => app.vault.getMarkdownFiles().map(({ path }) => path),
    folderExists: (path) => !path || app.vault.getFolderByPath(path) !== null,
    read: (path) => app.vault.read(fileAt(path)),
    async process(path, edit) {
      const file = fileAt(path);
      await app.vault.process(file, (source) => {
        assertFileStillAt(file, path);
        return edit(source);
      });
    },
    hasUnsavedChanges(path, saved) {
      const normalize = (text: string) => text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
      const normalized = normalize(saved);
      return app.workspace.getLeavesOfType("markdown").some(({ view }) =>
        view instanceof MarkdownView && view.file?.path === path && view.getMode() === "source"
        && normalize(view.editor.getValue()) !== normalized);
    },
    async create(path, source) {
      await app.vault.create(path, source);
    },
    async trash(path, validate) {
      const file = fileAt(path);
      const source = await app.vault.read(file);
      assertFileStillAt(file, path);
      validate(source);
      await app.vault.trash(file, false);
    },
  };
}
