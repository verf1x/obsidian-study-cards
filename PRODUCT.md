# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary audience is developers who already use Obsidian and prepare for technical interviews from their own question-and-answer notes. The same workflow supports other people who study from Obsidian notes, including learners preparing for technical exams.

## Product Purpose

Help people practice recalling answers from the Markdown notes they already keep in Obsidian. On first use, a learner should be able to connect existing notes and complete a free check without instructions from the maintainer. [First-use design task](https://github.com/verf1x/obsidian-study-cards/issues/44)

## Positioning

Practice long-form answers from Markdown notes, check them against the full reference in those notes, and retry the questions answered incorrectly in a separate session. Technical notes can contain code, tables, math, and links that carry meaning in the reference answer. [Positioning decision](https://github.com/verf1x/obsidian-study-cards/issues/12#issuecomment-7047678406)

## Operating Context

- Study Cards runs inside the Obsidian workspace on desktop and mobile. It targets Windows, macOS, Linux, Android, and iOS.
- The user chooses notes or folders as card sources and groups them in named study sections. A single-card note yields one card. In a collection, each section at the selected heading level yields a card.
- The end-to-end acceptance scenario uses a collection of 100 questions, a free check with 20 questions, and a mistake retry.
- A learner can start a free check on a computer and resume it on a phone after syncing the vault files. [Shared study state](docs/adr/0006-shared-study-state.md)

## Capabilities and Constraints

- Markdown in the vault supplies the questions and reference answers. Connecting existing notes shows a preview and requires confirmation before writing source properties or missing card IDs. [Source enrollment](docs/adr/0001-explicit-note-enrollment.md)
- Study lets users read answers and set mastery status. Free check lets users grade their own answers and keeps the result in history. Spaced repetition schedules reviews based on the answer grade. [Glossary](GLOSSARY.md)
- A free check keeps its card selection and order. If the user edits a note during the session, the displayed question and reference answer follow the saved Markdown. [Free check behavior](docs/adr/0004-live-markdown-in-free-checks.md)
- Study Cards works locally without an account or telemetry. Shared progress lives in `Study Cards/data.json` and can travel with a vault sync service. [Release decisions](https://github.com/verf1x/obsidian-study-cards/issues/3) · [Shared study state](docs/adr/0006-shared-study-state.md)
- The interface ships in English and Russian. Use the [glossary](GLOSSARY.md) for product terms in both languages.

## Brand Commitments

Use the name **Study Cards** and the permanent plugin ID `study-cards`. [Naming and identity](docs/adr/0003-stable-plugin-id.md)

## Evidence on Hand

- The [test vault](fixtures/test-vault/) includes a 100-question HTTP collection, standalone notes, and reference answers with Markdown formatting and math.
- The [0.1.3 acceptance report](docs/acceptance/0.1.3.md) covers Windows, Linux under WSL2, and Android. It records a free check, a mistake retry, and continuation after transferring vault files between Windows and Android. Compatibility on macOS and iOS remains unverified.

## Product Principles

- Let people start from notes they already have.
- Keep the full reference answer available when a learner checks their recall.
- Make it easy to pick up an unfinished free check and practice the questions missed.
- Keep source changes and self-assessment under the learner's control.

## Accessibility & Inclusion

The redesign must work in a wide desktop pane and a narrow touch layout. Verify keyboard focus, light and dark Obsidian themes, and both interface languages. [Redesign acceptance criteria](https://github.com/verf1x/obsidian-study-cards/issues/44)
