---
name: octobot-commit
description: Commit session changes back to the parent workspace at a target commit
argument-hint: <commit-id>
disable-model-invocation: true
---

Commit the changes from this session back to the parent workspace, targeting commit $ARGUMENTS.

1. **Check current state:** Run `git status` and `git log --oneline -5` to understand current HEAD and uncommitted changes.

2. **Create commit(s) first:** Before rebasing, commit all your local changes:
   - Review changes with `git diff` to understand all modifications
   - Group related changes logically if multiple commits are appropriate
   - Each commit should be atomic and represent a logical unit of work
   - Use imperative mood in messages ("Add feature" not "Added feature")
   - First line 50 chars or less, explain the "why" in the body if needed
   - Git user configuration (user.name and user.email) is automatically set from the server's git config
   - Stage and commit all changes before proceeding to the next step

3. **Pull with rebase:** Once all changes are committed, rebase onto the target commit:
   - Run `git pull -r origin $ARGUMENTS`
   - This will fetch the target commit and rebase your commits on top of it

4. **Handle conflicts if they occur:**
   - If rebase conflicts arise, work with the user to resolve them
   - Show the conflicting files with `git status`
   - Explain the conflicts clearly and ask the user how they want to proceed
   - After resolving conflicts, continue with `git rebase --continue`
   - If the user wants to abort, use `git rebase --abort`

5. **Verify:** Confirm all changes are committed and history is rebased to $ARGUMENTS.
