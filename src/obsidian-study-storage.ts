import type { App } from "obsidian";
import { t } from "./localization";
import { sharedStudyPath, SharedWriteNotApplied, type StudyStorageIO } from "./study-storage";

const folder = "Study Cards";
const deviceKey = "study-cards-device-storage";
const records = "vaults";

export async function obsidianStudyStorage(app: App, onClose: (close: () => void) => void): Promise<StudyStorageIO> {
  let key: unknown = app.loadLocalStorage(deviceKey);
  if (typeof key !== "string") {
    key = globalThis.crypto.randomUUID();
    app.saveLocalStorage(deviceKey, key);
  }
  const vaultKey = key as string;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("study-cards", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(records); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.onversionchange = () => db.close();
  onClose(() => db.close());

  const { vault } = app;
  const { adapter } = vault;
  async function readShared() {
    if (!await adapter.exists(sharedStudyPath)) return null;
    try {
      return await adapter.read(sharedStudyPath);
    } catch (error) {
      if (!await adapter.exists(sharedStudyPath)) return null;
      throw error;
    }
  }

  return {
    readShared,
    async writeShared(expected, next) {
      let publicationStarted = false;
      try {
        if (expected === null) {
          if (!await adapter.exists(folder)) {
            try {
              await vault.createFolder(folder);
            } catch (error) {
              if (!await adapter.exists(folder)) throw error;
            }
          }
          if (await adapter.exists(sharedStudyPath)) throw new Error(t("sharedFileAppeared"));
          publicationStarted = true;
          await vault.create(sharedStudyPath, next);
          return;
        }
        await adapter.process(sharedStudyPath, (actual) => {
          if (actual !== expected) throw new Error(t("sharedFileChanged"));
          publicationStarted = true;
          return next;
        });
      } catch (error) {
        if (publicationStarted) throw error;
        throw new SharedWriteNotApplied(error instanceof Error ? error.message : String(error));
      }
    },
    readDevice() {
      return new Promise((resolve, reject) => {
        const request = db.transaction(records).objectStore(records).get(vaultKey);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    },
    writeDevice(next) {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(records, "readwrite");
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error(t("localCopyWriteFailed")));
        transaction.objectStore(records).put(next, vaultKey);
      });
    },
  };
}
