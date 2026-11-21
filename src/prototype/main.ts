import type { WorkspaceLeaf } from "obsidian";
import StudyCardsPlugin from "../main";
import type { WatchVault } from "../source-modals";
import type { StudyCards } from "../study-cards";
import { PrototypeChecks } from "./check";
import { PrototypeView } from "./view";

export default class StudyCardsPrototype extends StudyCardsPlugin {
  private readonly checks = new PrototypeChecks();

  protected createView(leaf: WorkspaceLeaf, study: StudyCards, watch: WatchVault, openNote: (path: string) => Promise<void>) {
    return new PrototypeView(leaf, study, watch, openNote, this.checks);
  }
}
