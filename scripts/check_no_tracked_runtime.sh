#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

violations=()
while IFS= read -r tracked_path; do
  case "$tracked_path" in
    .env|.env.*)
      if [[ "$tracked_path" != ".env.example" ]]; then
        violations+=("$tracked_path")
      fi
      ;;
    *.db|*.db-*|*.sqlite|*.sqlite3|*/local_core_token.txt|*/auth.json|data/chrome-automation-profile/*)
      violations+=("$tracked_path")
      ;;
  esac
done < <(git ls-files)

if (( ${#violations[@]} > 0 )); then
  echo "Tracked secret/runtime file paths detected:" >&2
  printf '  %s\n' "${violations[@]}" >&2
  exit 1
fi

echo "Tracked secret/runtime file check: PASS"
