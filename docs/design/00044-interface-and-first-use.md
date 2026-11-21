# Study Cards interface and first-use redesign

[Design issue #44](https://github.com/verf1x/obsidian-study-cards/issues/44) · [Implementation issue #48](https://github.com/verf1x/obsidian-study-cards/issues/48)

## Approved Orca prototype

Use these captures when comparing the layout in Obsidian.

| Screen | Details to compare |
| --- | --- |
| [First use](issue-44/connect-notes.png) | A compact pane header and one primary action. Note selection and preview stay in the pane. |
| [Practice](issue-44/practice.png) | The section name and card count sit beside **Test yourself**. Secondary study actions occupy compact rows with dividers. |
| [Manual selection](issue-44/manual-selection.png) | The pane tabs remain visible in setup. The note group headings and counts sit within a scrollable list, with the selection count and launch controls below it. |

## Agreed first-use flow

When there are no study sections, the primary action is **Connect notes**. The user selects existing notes and previews the cards those notes yield. The preview suggests an editable name for the first study section. One confirmation creates the section and connects the selected notes. Study Cards writes note properties and missing card UUIDs only after that confirmation, as specified in [ADR 0001](../adr/0001-explicit-note-enrollment.md).

## Agreed navigation

- After connecting notes, **Test yourself** opens free check setup with a proposed selection. The user can confirm it or change it before starting.
- In a vault with connected cards, Study Cards opens to the actions the learner can take now. The learner can continue an unfinished free check, start a new one, or retry mistakes when available. The catalog is one action away through **Cards**.

## Prototype brief for review

The learner has an HTTP collection and a single-card note to prepare for a technical interview. Give them the goal of starting a free check and retrying a missed question. Record where they hesitate or ask for help.

1. Connect the two notes and confirm the card preview under an editable study section name. Open setup with **Test yourself**. The agreed prototype proposes five random questions and lets the learner change the count or selection method.
2. Keep the question, answer reveal, and self-assessment in one focused session view. Use the ETag reference answer from the test vault to check that a long answer with code and a table is readable. Keep the result and **Retry mistakes** within the same flow.
3. Return to the activity overview and find the catalog, study, spaced repetition, and an unfinished free check. In a second run, search for and select two nonconsecutive collection questions and the single-card note, as specified in [#43](https://github.com/verf1x/obsidian-study-cards/issues/43).

Compare the current Obsidian layout with an activity-first workspace that uses Obsidian theme colours and puts session controls around the question. Check both a wide pane and a narrow touch layout in light and dark themes, in English and Russian, including keyboard focus.

## Prototype feedback

The controls and their shapes worked for the maintainer. The surrounding layout made the plugin feel like a website. The next revision puts **Practice** and **Cards** in a compact strip at the top of the pane, uses Obsidian surface colours, and starts with the study section and its actions.

The merged manual selection in [#43](https://github.com/verf1x/obsidian-study-cards/issues/43) establishes the selection and validation rules. In the next prototype, manual selection occupies the free check setup in the pane. The search and **All** / **Selected** controls sit above the list, with the count and start action below it.
