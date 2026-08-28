# Test suite review

Eight parallel readers over all 81 files, 38,343 lines. Six fixes landed in
`fda6405`; everything below is reported, not changed.

## Fixed already (fda6405)

| test | was |
|---|---|
| `keyboard.test.ts` "keyboard events bubble up the DOM" | asserted `childEvents.length === 0` and `parentEvents.length === 0` — nothing bubbles — under a comment saying events should reach the parent |
| `keyboard.test.ts` "non-TTY environment doesn't set up keyboard handling" | sole assertion `expect(termdom).toBeDefined()` on a just-constructed object |
| `z-index.test.ts` "z-index does not apply to a static box" | no static box; both were `position:absolute`, so document order decided and the rule went unchecked |
| `termdom.test.ts` "can render HTML to terminal without errors" | zero assertions, never called `attach()`, so nothing painted |
| `popover.test.ts` | ended on a bare `togglePopover(true)` with no matcher, under a comment about closing |
| `emoji.test.ts` / `flat-tree-walker.test.ts` | "text after emoji gets truncated" and "FAILING - …" named bugs their bodies disprove |

## 1. Tests that cannot fail

**`widgets.test.ts:352` — the only meter level-colour test is blind to level colour.**
Renders `value` 9, 5, 1 on a 0–10 meter and asserts `new Set([...]).size === 3`.
The sibling test at :341 establishes meters fill proportionally, so the three
ANSI strings differ by *fill length* alone. Delete every level colour and it
still passes.

**`color-rendering.test.ts:34` and `:152` — two tests asserting opposite claims
with the identical blind assertion.** Both strip SGR then `.trim()`, which
deletes the background-filled spaces that are the entire subject. "background
colors fill full width" and "inline elements do not extend background" cannot
distinguish each other.

**`layout.test.ts:780` — `expect(reconstructed.length).toBeGreaterThanOrEqual(0)`.**
A string length is never negative. This closes 35 generated tests whose every
other assertion is inside `for (const fragment of fragments)`; if
`lineFragments()` returned `[]` all 35 stay green. Related: `:776` where
`indexOf("", cursor)` returns `cursor` for empty fragments — exactly what a
white-space bug produces.

**`layout.test.ts:458` — "inline run with mixed content" asserts only
`not.toBeNull()`** on a `querySelector` result, engine handle unused, comment
admitting `// Test passes if no errors are thrown`. Same shape at `:378`,
`:100`, `:186`, `:201`, `:390`.

**`presentational-hints.test.ts:156` — half the guard is unreachable.** `names`
is the union of the two tables, so "in neither table" cannot occur. The
docblock claims that case fails the guard. A Rendering-section hint nobody
added to either table passes silently — the exact drift the test exists for.

**`serialization.test.ts:69` — the round trip checks idempotence, not fidelity.**
`markup` appears only inside the label string. A serializer that stably loses
content passes; the docblock names the `<pre>` newline bug as one this catches,
and it does not.

**`test-utils.test.ts:119` — a race that cannot detect what its comment claims.**
Rejects at 2000ms; the engine's own fallback resolves at 1000ms
(`exchange.ts:683`). Hanging on the fallback — the stated failure mode — passes.

**`ansi.test.ts` — 11 snapshot-only tests** (812, 844, 910, 927, 945, 961, 1015,
1053, 1083, 1110, 1130) with no code assertion. `-u` blesses any junction
regression. `paint-frames.test.ts` is the good counterexample.

**`flexbox.test.ts:169`, `:370` — width loops that cannot fail.** An xterm buffer
line is exactly `cols` wide, so `line.length <= 80` is structural.

**`offset-geometry.test.ts:110`** — `scrollWidth` compared only to `clientWidth`;
all-zero passes. **`grid.test.ts:1512`** — `mutationMatchesFresh` has no floor,
so any bug symmetric across both paths passes.

**`textarea.test.ts:289`** — `cursorY >= 0 && cursorY < 6` is clamped by the
emulator. **`textarea.test.ts:432`** — `getSelection()?.isCollapsed ?? true`
swallows a null selection, the regression it guards.

**`fuzz/document.test.ts:181`** — instrumented: 11 of 25 runs assert nothing
(three `continue` guards). **`fuzz/layout.test.ts:179`** — `wrappers` has no
`minLength`, so the property often compares a document against itself.

## 2. The 12 disabled tests that pass today

20 `test.todo` blocks hold 512 lines of never-run code. Verified by flipping all
of them in a throwaway worktree: the six affected files baseline at 174 passed /
19 todo, and run 186 passed / 7 failed with the todos live.

Passing now, should be enabled:
- `cascade.test.ts` — property inheritance, multiple stylesheets, `!important`,
  complex selectors, media queries
- `layout.test.ts` — all four
- `stylesheet.test.ts` — StyleManager auto-refresh
- `flexbox.test.ts` — `white-space: pre` keeps whitespace items
- `viewport-ansi.test.ts` — overflow pushes up to fit. Its stated reason is
  false: it says push-up is unimplemented and cross-references a
  `test.todo` in `viewport.test.ts` that does not exist; push-up *is*
  implemented and asserted at `viewport.test.ts:369`.

Genuinely failing (leave as todo): five in `cascade.test.ts`, two in
`pseudo-element.test.ts`. Note `cascade.test.ts:272` "CSS specificity" fails on
a broken fixture — the sheet says `#id` but the element is `id="test"` — not a
missing feature. And `:509`'s comment claims border shorthand expansion is
unimplemented; the border half works.

## 3. Wrong-confidence tests

- `hover.test.ts:290` — titled "at most one hit-test per frame", asserts
  `toBeLessThan(3)`. I measured it: two `mousemove` events fire (clientY 0 then
  2). The sweep *does* coalesce to one; the extra is a stale hover left pending
  from setup. Needs a setup drain, not a looser bound. **Attempted and reverted
  — this one needs more care than a rushed fix.**
- `grid.test.ts:734` — "an implicit track before the explicit grid shifts
  everything after it" demonstrates the opposite; `grid-column: -2/-1` resolves
  to the one explicit track and the assertions confirm nothing implicit exists.
- `grid.test.ts:158` — "min-content and max-content" never uses `max-content`.
- `bidi.test.ts:113` — byte-for-byte copy of `:83`; the DECRQM negotiation it
  names is never observed.
- `layout.test.ts:439` — "inline head element gets **incorrect** rect" asserts
  the correct value and passes.
- `layout-list-style-position.test.ts:99` — "default list behavior is inside
  positioning"; the initial value is `outside` and both assertions hold either way.
- `ansi.test.ts:173` — "no scroll command when offset unchanged" asserts the
  output contains no capital `S` or `T` anywhere, not SU/SD.
- `ansi.test.ts:365` — junction check includes plain corners `┌┐└┘`, which any
  single box produces.
- `margin-collapsing.test.ts:184` — "border or height stops self-collapse" tests
  no border.

## 4. Stale comments

- **Yoga is gone from `src/`** but named as live machinery in
  `layout.test.ts:217, 253, 439, 1228, 1234`. `styleYogaNode` and `RectLength`
  have zero hits in `src/` yet head four and three tests respectively.
- `layout.test.ts:1303, 1348, 1384, 1400` — `// CURRENT: Creates phantom lines`
  above `expect(phantomLines).toBe(0)`. All four pass; a reader debugging a
  failure is told it is expected.
- `select.test.ts:1` — docblock says "no popup machinery"; ten tests below drive
  the popup.
- `document-mode.test.ts:170` (`detectCursor`), `scroll-unification.test.ts:4`
  (`ScrollingManager`), `offset-geometry.test.ts:130` (`contentBoxSize()`),
  `flex.test.ts:599` (`GUTTER_ALL`), `textarea.test.ts:445` (`styles.test.ts`) —
  all name things that do not exist. Also `detectCursor`, `commitScroll`,
  `bufferToVisibleText`, `maxLayoutHeight` survive only in test comments.
- Changelog-style comments (against CLAUDE.md) throughout `tables.test.ts`,
  `z-index.test.ts`, `shadow-dom.test.ts`, `stacking.test.ts`, `emoji.test.ts`.

## 5. Duplication

- `keyboard.test.ts` inlines emit-then-wait ~110 times and redefines a local
  helper for it **eight** times with silently differing waits (one tick vs two);
  two of the eight are character-identical in adjacent tests.
- `cascade.test.ts` copy-pastes the same three-line StyleManager/LayoutEngine
  wiring **13 times**; `test-utils.ts:432` already exports `styleManagerFor`.
- `createHTMLDocument` is copy-pasted across **six** files with the same comment.
- `cellAt` written out **nine** times; `type()` three times.
- `MockProcess` is reimplemented three times (`keyboard`, `mouse`, `hover`).
- `layout.test.ts:1070` and `:1125` are the same test, same name, byte-identical
  but for one comment. Both run.

## 6. Harness

- **`fuzz/shrink.test.ts:198` — `tag()` restarts its counter at 0 on every call**,
  and it is called after every action. Newly arrived elements get `data-f="e0"`,
  an id that already exists; `find()` returns the first match, so recorded
  repros don't describe what happened and new nodes are under-mutated.
- `test-utils.ts:392` — `writeANSI`'s comment says "after test passes"; it is
  called mid-test and writes unconditionally. 13 sites write 35 tracked files
  that nothing ever reads back. The suite dirties the working tree every run.
- `test-utils.ts:263` — `getVisibleText()` is `return this.getPlainText()`;
  `getScreenContents()` is `getStaticANSI()` plus a newline. Two names each,
  used interchangeably across the suite, implying a distinction that isn't there.
- `logical-properties.test.ts` leaks ~33 `TermDOM` instances (one `dispose()` in
  the file). Most tests call `dispose()` as the last statement rather than in a
  `finally`, so a failing assert leaks.
- `fuzz/serializer.test.ts` pins seed and run count, so CI explores the same 200
  cases forever; all leaves come from 47 hand-written constants, so no
  character-level escaping bug can be generated.
- `fuzz/scenes.ts` — roughly half the declared vocabulary is unreachable under
  `npm test` (`SHAPES` is set nowhere; `CLUSTERS`, `SHAPE_CLASSES`, `dialog`,
  and four actions never run). The `made` id (`m0`..`m7`) can never be selected,
  so nothing a script creates can afterwards be removed or restyled.

## 7. The security test cannot fail (highest severity)

**`security.test.ts:40` — reverting the sanitiser leaves this test green.**

`FORBIDDEN_BYTES` deliberately excludes `0x1b`, and none of the four
`FORBIDDEN_SEQUENCES` (`"\x1b]0;"`, `"\x1b[2J"`, `"\x1b]"`, `"\x1bP"`) can be
formed by a bare surviving ESC. Verified empirically: splicing a raw ESC back
into the current output where the payload's would land produces **zero**
assertion failures. Three of six payloads — `"tail\x1b"`, `"\x1b"`,
`"edge0123456789012345678\x1b"` — are checked by nothing, and the comment
names the trailing case as *the one that used to survive*.

Reverting `screen.ts:1031` (`if (code < 0x20 || (code >= 0x7f && code < 0xa0))
continue;`) would not fail this suite.

**No positive control either.** Every assertion is an absence, so a blank frame
or a silently-dropped `textContent` passes all six payloads. The sanitised text
does reach the output today (`before]0;pwnedafter`), so one
`expect(out).toContain("before]0;pwned")` closes it.

Fix direction: assert on the emitted cell content — the row's text is exactly
`"tail"` — not only on absent byte patterns.

**`security.test.ts:70` — two of three injection vectors are inert.** The
`<img onerror>` third can never fire (termdom loads no images; `onerror` exists
in `src/` only as an attribute-name table entry). And the flag is set on the
*test realm's* `globalThis`, while `dom.window !== globalThis` — if inline
handlers were ever compiled they would most plausibly evaluate against the
document's window, and the test would still read `false`. Assert
`(dom.window as any).__termdomPwned` too. The `onclick` third is genuine.

## 8. Width oracle generates 87% duplicates

`width-oracle-domain.ts:89` — `seed * 1103515245` reaches ~2.3e18, past 2^53,
so the low bits are lost before the mask. Measured: the state cycles after
**16,404 draws**, and `randomMixedStrings()` returns 20,000 entries but only
**2,581 distinct strings**. The committed oracle stores 20,000 widths for 2,581
distinct inputs. Determinism is unaffected; the breadth is not there.
`Math.imul(seed, 1103515245)` restores the full period.

## 9. Three more disabled tests that pass

- `stylesheet.test.ts:254` — "StyleManager auto-refresh on DOM changes" passes
  completely (black → red on adding a sheet → blue on editing it).
- `pseudo-element.test.ts:186` — all four rendering assertions pass; the one
  failure is `shouldCreatePseudoElement(el, "::before")` for `content: ""`,
  which returns `true`. Per CSS `content: ""` *does* generate an empty box, so
  the engine looks right and the test's expectation looks wrong.
- `pseudo-element.test.ts:292` — genuinely fails: `flowWalker(container)` yields
  only `"MIDDLE"`, never `"BEFORE"`. Either the walker does not enumerate
  pseudo-elements or the expectation is obsolete. It also names
  `ExpandedTreeWalker`, which does not exist.

## 10. More stale comments (group 5)

- `viewport.test.ts:67` — `// FAILING: Currently renders at top` on a file that
  runs 38 passed, 0 failed.
- `viewport.test.ts:198` — `// TODO: ...when coordinate transformation is
  implemented`; the very next test proves it is.
- `viewport.test.ts:1124` — "the bottom sits on the last screen row" is wrong by
  four rows (measured: `screenTop` 2, content on rows 2–13 of 18).
- `viewport.test.ts:50` — "leaving 2 lines available"; row 8 of 10 leaves 3, as
  the same comment says correctly at lines 75 and 234.
- `css-conformance.test.ts:10` — "Snapshots are Bun-only"; `installSnapshotMatcher`
  is gated on `!isBrowser`, so they run on node too.
- `css-conformance.test.ts:373` — `KNOWN_GAPS` is `[]`, so the loop registers
  zero tests under a three-line comment describing the mechanism.

## 11. Weak security-adjacent assertions worth strengthening

- `width-measurement.test.ts:458` — "takes the rest of its run with it" never
  checks the rest of the run; `expect(stringWidth(second)).toBe(2)` passes today
  and would make the test check its name.
- `width-measurement.test.ts:481` — "a split reply is still a reply" asserts only
  `keys.length === 0`; discarding the reply entirely also passes. The reply *is*
  applied (2 → 1 across chunks), so asserting that is free.
- `observers.test.ts:330` — "fires at every threshold crossing" accepts two
  callbacks out of six possible.
- `style-parity.test.ts:176` — `POSITION_DEPENDENT` skips all three margin
  probes, so five margin rows assert nothing. Measured: only `margin: auto`
  actually disagrees; the blanket skip is four times broader than the problem.
