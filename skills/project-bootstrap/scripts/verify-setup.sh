#!/usr/bin/env bash
# project-bootstrap verification: checks that the workflow skeleton is complete.
# Usage: bash verify-setup.sh <project-root>
set -u

ROOT="${1:-.}"
cd "$ROOT" || { echo "✗ directory not found: $ROOT"; exit 1; }

PASS=0
FAIL=0
check() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "✗ $desc"
    FAIL=$((FAIL + 1))
  fi
}

echo "== File presence =="
check "docs/template/tech-design-template.md" test -f docs/template/tech-design-template.md
check "docs/design/tech-design.md" test -f docs/design/tech-design.md
check "AGENTS.md" test -f AGENTS.md
check "TODOS.md" test -f TODOS.md
check ".gitignore" test -f .gitignore

echo "== Git status and ignore defense line =="
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  check "git repository" true
  for pattern in ".env" "secrets/x.pem" "node_modules/x"; do
    if git check-ignore -q "$pattern"; then
      echo "✓ .gitignore covers $pattern"
      PASS=$((PASS + 1))
    else
      echo "⚠ .gitignore does not cover $pattern (ignore if this risk does not apply)"
    fi
  done
else
  echo "✗ not a git repository (run git init first)"
  FAIL=$((FAIL + 1))
fi

echo "== Placeholder leftovers in docs =="
if grep -rnq "{{" docs/design/tech-design.md AGENTS.md TODOS.md 2>/dev/null; then
  echo "⚠ placeholders found; fill them from the interview (write \"to be designed\" instead of leaving placeholders):"
  grep -rn "{{" docs/design/tech-design.md AGENTS.md TODOS.md 2>/dev/null | head -5
else
  echo "✓ no placeholders left"
  PASS=$((PASS + 1))
fi

echo ""
echo "Result: $PASS passed / $FAIL failed"
[ "$FAIL" -eq 0 ]
