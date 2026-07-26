#!/usr/bin/env bash
# For each (fix-commit, test-file, test-pattern, source-files): restore pre-fix
# sources, run the test, expect FAIL (red); restore HEAD, run again, expect
# PASS (green). Counts come from bun's summary lines ("N pass" / "N fail").
cd /Users/brian/Projects/termdom
run_counts() { # -> "pass fail"
  local out; out=$(timeout 60 bun test "$1" -t "$2" 2>&1 | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g')
  local p f
  p=$(echo "$out" | grep -oE "^ *[0-9]+ pass" | grep -oE "[0-9]+" | head -1)
  f=$(echo "$out" | grep -oE "^ *[0-9]+ fail" | grep -oE "[0-9]+" | head -1)
  echo "${p:-0} ${f:-0}"
}
# Sources have been renamed twice: src/x.ts -> src/_x.ts (single public
# module), then src/_x.ts -> src/internal/x.ts (subdirs hide internals).
# Fix commits list historical paths; map each to its current location so the
# pre-fix content lands where HEAD's imports look.
current_path() {
  local f="$1"
  [ -e "$f" ] && { echo "$f"; return; }
  local base="${f##*/}"; base="${base#_}"
  local mapped="src/internal/$base"
  [ -e "$mapped" ] && { echo "$mapped"; return; }
  echo "$f"
}

audit() {
  local commit="$1"; shift; local testfile="$1"; shift; local pattern="$1"; shift; local files=("$@")
  local restore=()
  for f in "${files[@]}"; do
    local dest; dest=$(current_path "$f")
    # Historical content imports siblings by era-specific names. In
    # src/internal/ the flat "./x.js" form is already correct; only the
    # underscore era needs mapping back to plain names.
    git show "$commit^:$f" 2>/dev/null | sed -E 's|(["(])\./_([a-z]+)\.js|\1./\2.js|g' > "$dest"
    [ -s "$dest" ] || { echo "SKIP       $pattern (no $f at $commit^)"; git checkout -q -- "${restore[@]}" "$dest" 2>/dev/null; return; }
    restore+=("$dest")
  done
  read -r rp rf <<< "$(run_counts "$testfile" "$pattern")"
  git checkout -q -- "${restore[@]}"
  read -r gp gf <<< "$(run_counts "$testfile" "$pattern")"
  if [ "$rf" -ge 1 ] && [ "$gf" -eq 0 ] && [ "$gp" -ge 1 ]; then echo "RED/GREEN OK   $pattern"
  elif [ "$rf" -eq 0 ]; then echo "NEVER-RED  !!  $pattern (red run: ${rp}p/${rf}f - passes on broken code)"
  else echo "NOT-GREEN  !!  $pattern (green run: ${gp}p/${gf}f)"; fi
}
audit fc25555 tests/document-mode.test.ts "coalesced, not dropped" src/termdom.ts
audit 49f82f4 tests/layout-invalidation.test.ts "swallow later mutations" src/layout.ts
audit cafc966 tests/keyboard.test.ts "batched chunk of arrow sequences" src/termdom.ts
audit cafc966 tests/keyboard.test.ts "packed behind a stray cursor report" src/termdom.ts
# Expected NEVER-RED: pre-culling code paints everything, so it cannot wrongly
# cull. This test's true red is an UNSOUND culling implementation (extent = own
# box, ignoring children) -- verified by sabotage on 2026-07-26.
audit 057ad8c tests/document-mode.test.ts "absolute child positioned far" src/flex.ts src/layout.ts src/termdom.ts
audit 730ba9f tests/keyboard.test.ts "parks the real terminal cursor" src/termdom.ts src/ansi.ts
audit e07b992 tests/keyboard.test.ts "wide characters in an input" src/termdom.ts
audit 978fa57 tests/viewport.test.ts "parks at the content bottom" src/ansi.ts

# Usage: add an `audit <fix-commit> <test-file> <test-pattern> <source-files...>`
# line for each new bug fix. A regression test earns its place by failing on
# the code it indicts: red on the pre-fix sources, green on HEAD.
audit HEAD tests/document-mode.test.ts "keeps the diff aligned with the screen" src/_termdom.ts src/_ansi.ts
