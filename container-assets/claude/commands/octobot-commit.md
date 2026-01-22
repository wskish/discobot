---
name: octobot-commit
description: Commit session changes back to the parent workspace at a target commit
argument-hint: <commit-id>
disable-model-invocation: true
---

Commit the changes from this session back to the parent workspace, targeting commit $ARGUMENTS.

1. **Check current state:** Run `git status` and `git log --oneline -5` to understand current HEAD and uncommitted changes.

2. **Fetch and compare with target:** If $ARGUMENTS is not the current HEAD:
   - Fetch the latest: `git fetch origin`
   - Analyze differences: `git log --oneline HEAD..$ARGUMENTS` and `git log --oneline $ARGUMENTS..HEAD`

3. **Rebase if needed:** If $ARGUMENTS has commits not in HEAD, rebase your changes:
   - `git rebase $ARGUMENTS`
   - Resolve any conflicts that arise

4. **Review session changes:** Use `git diff` to understand all modifications. Group related changes logically if multiple commits are appropriate.

5. **Create commit(s):**
   - Each commit should be atomic and represent a logical unit of work
   - Use imperative mood in messages ("Add feature" not "Added feature")
   - First line 50 chars or less, explain the "why" in the body if needed

6. **Verify:** Confirm all changes are committed and history is rebased to $ARGUMENTS.
