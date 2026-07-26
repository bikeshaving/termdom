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
audit() {
  local commit="$1"; shift; local testfile="$1"; shift; local pattern="$1"; shift; local files=("$@")
  git checkout -q "$commit^" -- "${files[@]}" 2>/dev/null || { echo "SKIP       $pattern (checkout failed)"; return; }
  read -r rp rf <<< "$(run_counts "$testfile" "$pattern")"
  git checkout -q HEAD -- "${files[@]}"
  read -r gp gf <<< "$(run_counts "$testfile" "$pattern")"
  if [ "$rf" -ge 1 ] && [ "$gf" -eq 0 ] && [ "$gp" -ge 1 ]; then echo "RED/GREEN OK   $pattern"
  elif [ "$rf" -eq 0 ]; then echo "NEVER-RED  !!  $pattern (red run: ${rp}p/${rf}f - passes on broken code)"
  else echo "NOT-GREEN  !!  $pattern (green run: ${gp}p/${gf}f)"; fi
}
audit fc25555 tests/document-mode.test.ts "coalesced, not dropped" src/termdom.ts
audit 49f82f4 tests/layout-invalidation.test.ts "swallow later mutations" src/layout.ts
audit cafc966 tests/keyboard.test.ts "batched chunk of arrow sequences" src/termdom.ts
audit cafc966 tests/keyboard.test.ts "packed behind a stray cursor report" src/termdom.ts
audit 057ad8c tests/document-mode.test.ts "absolute child positioned far" src/flex.ts src/layout.ts src/termdom.ts
audit 730ba9f tests/keyboard.test.ts "parks the real terminal cursor" src/termdom.ts src/ansi.ts
audit e07b992 tests/keyboard.test.ts "wide characters in an input" src/termdom.ts
audit 978fa57 tests/viewport.test.ts "parks at the content bottom" src/ansi.ts

# Usage: add an `audit <fix-commit> <test-file> <test-pattern> <source-files...>`
# line for each new bug fix. A regression test earns its place by failing on
# the code it indicts: red on the pre-fix sources, green on HEAD.
