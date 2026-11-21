# Obsidian Study Cards

Study cards for Obsidian.

## Local installation

Run `npm ci` and `npm run build`. Copy `main.js`, `manifest.json` and `styles.css` into `.obsidian/plugins/study-cards/` inside a test vault. Enable **Study Cards** in Community plugins, then open it from the ribbon or the command palette.

## Catalog and free-check prototype (#9)

Run `npm ci` and `npm run prototype -- "path to a new vault"`. Open that folder as a vault in Obsidian, enable its local Study Cards plugin, and open **Study Cards**. The vault includes a 100-question collection with a long first answer and a separate note to try connecting.

Switch between the list, table and answer preview in the catalog. Start a free check, reveal the answer with Space, grade with 1 or 2, and move with the arrow keys. Confirm the result to try retrying mistakes. Checks and history are held in memory for the lifetime of the plugin. The same setup command updates the prototype build and preserves the vault's notes and plugin data.

Create a study section, then add Markdown files or folders. The preview shows which notes will be connected and which headings become cards. For an existing note to join an active folder source automatically, set `qcards_source: true` in its properties.

Run `npm run typecheck` and `npm test` for local verification.

## Contributing

Start each change in a dedicated Git worktree and branch. Follow the [contribution workflow](AGENTS.md#contribution-workflow) to open a pull request, review the changes, and verify them before merging into `main`.
