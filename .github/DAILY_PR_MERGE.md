# Daily pull request merging

The `Daily pull request merge` workflow runs around 09:00 Asia/Seoul daily
(00:00 UTC). GitHub may delay scheduled runs. It checks all open PRs targeting
`main` and merges eligible PRs on the repository owner's behalf.

Eligibility requires a non-draft PR, a clean merge state, a successful
`node-ci` check, every reported check successful, and no outstanding required
reviews or changes requested. The `do-not-merge` and `no-auto-merge` labels
prevent merging. The merge uses the checked head commit and does not request
an administrator bypass. Ineligible PRs are retried on the next daily run.

This is automated status checking, not an AI or human code review. CI test
failures block the check. GitHub repository protection rules still apply.

Run the workflow manually from Actions to check eligibility immediately.
The manual run defaults to a dry run; uncheck `dry_run` to permit merges.
Each run records merged and skipped PR numbers in its Actions summary.
Disable the workflow in Actions to stop daily merging.

The workflow uses the repository's built-in `GITHUB_TOKEN` with contents and
pull request write permission. Merges made with this token do not trigger
other workflows listening for `push` events. Existing scheduled builds still
run independently. Workflow-file changes may require permissions this token
does not have; rejected merges are reported as failures.
