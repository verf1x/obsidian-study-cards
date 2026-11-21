# Obsidian Study Cards

Study cards for Obsidian.

## Local installation

Use Obsidian 1.8.7 or later. Run `npm ci` and `npm run build`. Copy `main.js`, `manifest.json` and `styles.css` into `.obsidian/plugins/study-cards/` inside a test vault. Enable **Study Cards** in Community plugins, then open it from the ribbon or the command palette.

## Catalog and free-check prototype (#9)

Run `npm ci` and `npm run prototype -- "path to a new vault"`. Open that folder as a vault in Obsidian, enable its local Study Cards plugin, and open **Study Cards**. The vault includes a 100-question collection with a long first answer, an information-entropy question with LaTeX, and a separate note to try connecting.

Switch between the list, table and answer preview in the catalog. Start a free check, reveal the answer with Space, grade with 1 or 2, and move with the arrow keys. Confirm the result to try retrying mistakes. Checks and history are held in memory for the lifetime of the plugin. The same setup command updates the prototype build and preserves the vault's notes and plugin data.

In an existing demo vault, connect `Материалы/Энтропия источника.md` to try the LaTeX example.

Create a study section, then add Markdown files or folders. The preview shows which notes will be connected and which headings become cards. For an existing note to join an active folder source automatically, set `qcards_source: true` in its properties.

Run `npm run typecheck` and `npm test` for local verification.

## Progress and backups

Study Cards stores shared progress in `Study Cards/data.json` inside the vault. Enable syncing of **Other file types** in Obsidian Sync and include the **Study Cards** folder. The last opened study section and recovery copies are stored on the device. If versions diverge, open the Study Cards tab to choose a version before making further changes.

Expand **Данные Study Cards** in the tab to export a backup or preview and import one. Copy Markdown notes separately. If the import shows a source as **Недоступен**, use **Переподключить** to find it at its new path. Card progress follows the UUID in the note.

## Contributing

Start each change in a dedicated Git worktree and branch. Follow the [contribution workflow](AGENTS.md#contribution-workflow) to open a pull request, review the changes, and verify them before merging into `main`.
