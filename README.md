# Obsidian Study Cards

Study cards for Obsidian.

## Local installation

Run `npm ci` and `npm run build`. Copy `main.js`, `manifest.json` and `styles.css` into `.obsidian/plugins/study-cards/` inside a test vault. Enable **Study Cards** in Community plugins, then open it from the ribbon or the command palette.

Create a study section, then add Markdown files or folders. The preview shows which notes will be connected and which headings become cards. For an existing note to join an active folder source automatically, set `qcards_source: true` in its properties.

Run `npm run typecheck` and `npm test` for local verification.

## Contributing

Start each change in a dedicated Git worktree and branch. Follow the [contribution workflow](AGENTS.md#contribution-workflow) to open a pull request, review the changes, and verify them before merging into `main`.
