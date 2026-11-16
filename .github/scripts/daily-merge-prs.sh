#!/usr/bin/env bash
set -euo pipefail

: "${GH_REPO:?Set GH_REPO to owner/repository}"
DRY_RUN="${DRY_RUN:-true}"
if [[ "$DRY_RUN" != true && "$DRY_RUN" != false ]]; then
  echo 'DRY_RUN must be true or false' >&2
  exit 1
fi

report() {
  printf '%s\n' "$1"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
}

report "Daily pull request check (dry run: $DRY_RUN)"
# Fetch every page; failures stop the run instead of silently hiding PRs.
numbers=$(gh api --paginate "repos/$GH_REPO/pulls?state=open&base=main&per_page=100" --jq '.[].number')
if [[ -z "$numbers" ]]; then
  report 'No open pull requests targeting main.'
  exit 0
fi

failed=0
while IFS= read -r number; do
  # Refresh immediately before each merge, since earlier merges change the base.
  pr=$(gh pr view "$number" --repo "$GH_REPO" --json state,isDraft,baseRefName,headRefOid,mergeStateStatus,reviewDecision,reviews,statusCheckRollup,labels)
  if ! jq -e '
    .state == "OPEN" and .isDraft == false and .baseRefName == "main"
    and .mergeStateStatus == "CLEAN"
    and (.reviewDecision == "" or .reviewDecision == "APPROVED")
    and ([.reviews[] | select(.state != "COMMENTED" and .state != "PENDING")]
      | group_by(.author.login) | all(.[-1].state != "CHANGES_REQUESTED"))
    and ([.labels[].name] | all(. != "do-not-merge" and . != "no-auto-merge"))
    and (.statusCheckRollup | length > 0)
    and (.statusCheckRollup | any(.name == "node-ci" and .status == "COMPLETED" and .conclusion == "SUCCESS"))
    and (.statusCheckRollup | all(
      if .__typename == "CheckRun" then .status == "COMPLETED" and .conclusion == "SUCCESS"
      elif .__typename == "StatusContext" then .state == "SUCCESS"
      else false end))
  ' <<< "$pr" >/dev/null; then
    report "Skipped #$number: draft, checks, reviews, labels, or merge state do not permit merging."
    continue
  fi

  if [[ "$DRY_RUN" == true ]]; then
    report "Eligible #$number (dry run; no merge)."
  elif gh pr merge "$number" --repo "$GH_REPO" --merge --match-head-commit "$(jq -r .headRefOid <<< "$pr")"; then
    # No --admin: GitHub enforces repository merge rules. Match the checked SHA.
    report "Merged #$number."
  else
    report "Could not merge #$number; GitHub rejected the merge."
    failed=1
  fi
done <<< "$numbers"
exit "$failed"
