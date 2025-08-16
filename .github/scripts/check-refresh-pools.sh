#!/usr/bin/env bash
set -euo pipefail

violations=0

check_call() {
  local file="$1"
  local require_refresh="$2"   # true|false
  local context
  context="$(nl -ba "$file" | sed -n '1,500p')"

  # naive checks: look for fetchStockInfo invocations in this file
  mapfile -t lines < <(echo "$context" | grep -n 'node[^\n]*fetchStockInfo\.js' || true)
  for ln in "${lines[@]}"; do
    line_no="${ln%%:*}"
    snippet="$(echo "$context" | sed -n "$((line_no-2)),$((line_no+2))p")"
    has_refresh=$(echo "$snippet" | grep -q -- '--refresh-pools' && echo true || echo false)

    if [ "$require_refresh" = true ] && [ "$has_refresh" = false ]; then
      echo "❌ $file:$line_no expected --refresh-pools but not found"
      echo "$snippet"
      echo
      violations=$((violations+1))
    fi
    if [ "$require_refresh" = false ] && [ "$has_refresh" = true ]; then
      echo "❌ $file:$line_no should NOT force refresh for non-cron runs"
      echo "$snippet"
      echo
      violations=$((violations+1))
    fi
  done
}

# Daily build must require refresh
if [ -f ".github/workflows/daily-build.yml" ]; then
  check_call ".github/workflows/daily-build.yml" true
fi

# Stock recs: we allow conditional logic; only flag if it unconditionally forces refresh.
if [ -f ".github/workflows/stock-recs.yml" ]; then
  # If the file contains a conditional branch using github.event_name == 'schedule', skip strict check.
  if ! grep -q "github\.event_name.*schedule" ".github/workflows/stock-recs.yml"; then
    # No condition → treat as non-cron default; should NOT be forcing refresh
    check_call ".github/workflows/stock-recs.yml" false
  fi
fi

if [ "$violations" -gt 0 ]; then
  echo "Found $violations refresh-pools rule violation(s)."; exit 1
else
  echo "✅ refresh-pools usage complies with the rules."
fi
