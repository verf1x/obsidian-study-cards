## Contribution workflow

1. Start each change in a dedicated Git worktree on its own branch based on `origin/main`. Commit and push changes on that branch.
2. Use Matt Pocock's `pr` skill to write the pull request description. Open the pull request against `main` and include evidence from the checks you ran.
3. Run the `code-review` skill on the pull request diff against its base. Resolve blocking findings, verify the final revision with the applicable tests or checks, and record the results in the pull request.
4. Merge through GitHub after the final revision passes review and verification. Update `main` only by merging a pull request.

## Agent skills

### Issue tracker

Use GitHub Issues for tickets and specs. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the standard Matt Pocock triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context layout. See `docs/agents/domain.md`.
