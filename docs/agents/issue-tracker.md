# Issue tracker

Use `gh` with `verf1x/obsidian-study-cards` for tickets and specs. Verify the target with `gh repo view --json nameWithOwner` before publishing.

- Create: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --json number,title,body,labels,comments,state`.
- List: `gh issue list --state open --json number,title,body,labels,state`. Filter with `--label` as needed.
- Comment: `gh issue comment <number> --body-file <file>`.
- Label: `gh issue edit <number> --add-label <label>` or `--remove-label <label>`.
- Close: post the explanation as a comment, then run `gh issue close <number>`.
- Link a sub-issue: create it with `--parent <parent>` or run `gh issue edit <parent> --add-sub-issue <child>`.
- Mark a blocker: create the child with `--blocked-by <blocker>` or run `gh issue edit <child> --add-blocked-by <blocker>`. Start tickets once all blockers are closed.

## Wayfinding

Use an issue labeled `wayfinder:map` for the map. Add sub-issues labeled `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`. Take the first open, unassigned, unblocked ticket in map order. Claim it with `gh issue edit <number> --add-assignee @me`. Post the result, close the ticket, and link it from the map's decisions.

## Pull requests

**PRs as a request surface: no.**
