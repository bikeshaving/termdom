#!/usr/bin/env bash
# Run the test suite in small batches, each in its own `bun test` process.
#
# The whole suite in ONE process sits against a memory ceiling (see TESTING.md):
# peak RSS climbs to ~1.6 GB, the run stops making progress, and CI kills it with
# no summary -- indistinguishable from a hang. The trigger is not fully pinned
# down and adding a TermDOM-heavy test can tip a run that used to finish, so the
# durable fix is to bound peak RSS structurally: no single process ever holds more
# than BATCH files' worth of JSDOM/layout working set.
#
# Exits non-zero if any batch reports a failure or is killed before finishing, so
# a real test failure still fails the build.
set -uo pipefail
cd "$(dirname "$0")/.."

BATCH=${BATCH:-3}
FILES=(tests/*.test.ts)
n=${#FILES[@]}
fail=0

strip_ansi() { sed $'s/\x1b\\[[0-9;]*[a-zA-Z]//g'; }

for ((i = 0; i < n; i += BATCH)); do
	batch=("${FILES[@]:i:BATCH}")
	out=$(bun test "${batch[@]}" 2>&1)
	echo "$out" | strip_ansi
	# A batch that never printed a summary was killed mid-run (the memory
	# ceiling); treat that as a failure, not a pass.
	if ! echo "$out" | grep -qE 'Ran [0-9]+ tests'; then
		echo "::error::batch [${batch[*]}] did not finish (killed?)"
		fail=1
	elif echo "$out" | grep -qE '^\s*[1-9][0-9]* fail'; then
		fail=1
	fi
done

exit $fail
