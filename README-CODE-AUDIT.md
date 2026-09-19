# A read through both repos

19 September 2026. ~9,800 lines of source across `design-hub` and the sibling
`design-ai`, read looking for things worth changing. Every number here was
measured, and every claim about behaviour was run rather than reasoned about.

Four things were fixed. Two were rejected after looking. One is recommended and
deliberately not done.

---

## What was wrong

### 1. A DELETE that could destroy a card, and nothing to stop it

`worker/index.js` dispatched every route from one 1,313-line function of
sequential `if`s. Two of them matched a whole prefix:

```js
if (method === 'DELETE' && path.startsWith('/api/agent/session/'))
```

That handler deletes the card **and every session on it**. `resolveKey()` parses
an issue key out of anything it is given:

```
RYV-84/figma           -> RYV-84
RYV-84/skipp           -> RYV-84
RYV-84/anything/at/all -> RYV-84
```

So any DELETE under that prefix which was not caught by an earlier block
destroyed the card and answered `{ ok: true }`.

**Nothing did that**, because all six real DELETE subroutes are declared above
it. But "correct as long as nobody adds a route below this line, or mistypes
one" is not a property worth holding when the failure is silent data loss.
Putting the old matcher back fails ten of the new tests.

Its GET twin carried an exclusion list — `trigger`, `reassign`, `respond`,
`dismiss` — that had to grow by hand for every subroute added since, and had
fallen six behind (`skip`, `setaside`, `complete`, `state`, `reopen`, `figma`).
It only held because all six happen to be non-GET.

Both now match **one path segment**, which is the right test because ids are
always percent-encoded on the wire: `hub.mjs` and the board both send
`ryve%2Fryv-84%2Fdesign`, and `URL.pathname` keeps it that way. A real id never
contains a raw slash; anything that does is a subroute.

A structural test then found a third: `path.match(/\/respond$/)` matched any
path anywhere ending in `/respond`, then sliced it as though it began with
`/api/agent/session/`. Now anchored at both ends, like its neighbours.

### 2. The diagnostic tool could not read the credentials it was diagnosing

Three `.env` parsers: `hub.mjs`, `runner.mjs`, and `doctor.mjs`. The first two
were identical. The third was `/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/`, which
silently cannot read two things the others can:

```
export LINEAR_API_KEY=lin_abc     the `export ` prefix breaks the match
lowercase_key=value               the character class is upper-case only
```

`export FOO=bar` is valid in a file that is also sourced by a shell. On a `.env`
written that way, **`doctor.mjs` reports the Linear key as missing while the
runner reads it perfectly well** — and `doctor.mjs` is what you run when
something is already broken. A diagnostic that invents a fault is worse than no
diagnostic.

`hub.mjs` and `runner.mjs` now share `lib/env.mjs`. Each keeps its own *search*,
because those genuinely differ — `hub.mjs` is run by hand from anywhere and
looks from both the cwd and its own location; the runner walks up from the
project directory.

`doctor.mjs` still parses **independently**, and that was left deliberately. Its
comment already argued that a diagnostic must not share a bug with the thing it
diagnoses, and that argument is sound. But independence is not divergence, so
its parser is corrected and `env-parity` in `runner.test.mjs` runs both over a
corpus of real shapes and names the exact line if they ever disagree again.

### 3. A literal BOM inside the BOM stripper

```js
const stripBom = (s) => s.replace(/^<U+FEFF>/, '');   // runner.mjs
```

An actual invisible U+FEFF inside the regex — `od -c` shows `357 273 277`.
`hub.mjs` had a comment three files away saying exactly why not to do that.

The replacement **acquired the same bug on its first write**: `﻿` turned
back into a real U+FEFF somewhere on the way to disk. The new test caught it in
its own file. It is `String.fromCharCode(0xFEFF)` now — the way `runner.mjs`
already spells its path separator — and the test spells it that way too, so the
test cannot quietly acquire the bug it exists to catch.

### 4. Two GitHub link builders

`attach-report.mjs` carried a copy of `repoFileUrl()` under a comment promising
it matched `runner.mjs`. That is the sort of promise that stops being true
without anyone noticing. Now `lib/repo.mjs`, with the impure half — asking git
for the remote — left in the runner, which is what made the original
untestable.

---

## What looked wrong and was not

**Five "dead" exports.** `sessionWire`, `BRAND_KEYWORDS`, `OPTION_ID`,
`labelFor` and `decisionOf` appeared to be exported and referenced nowhere. They
are all used *inside their own files*; the grep that found them excluded the
defining file. Nothing was deleted. Worth recording because the first read was
wrong and deleting five things on it would have been easy.

**Fourteen `catch { return err('Invalid JSON') }` blocks** in the Worker. It is
repetition, and a `readJson(request)` helper would remove it — but each one is
three words long, reads correctly in place, and a helper would add a layer
between a route and its own 400. Left alone.

**`derive.mjs` duplicated across both repos.** Deliberate and already defended:
it is vendored with a SHA-256 parity check that `--smoke` verifies. Not
duplication, a contract.

**Three slug functions** — `slug()` in `runner.mjs`, `slug()` in
`report-html.mjs`, `segment()` in `report-route.mjs`, with different length
caps. They look mergeable and are not: the first feeds Hub session ids and is
identity-critical, the second makes HTML anchors, the third makes path segments
that have to survive a Windows path limit. Merging them would couple three
things that change for different reasons.

---

## The one worth doing, not done here

**`route()` is 1,313 lines.** Every handler is an `if` block inside one
function, and correctness depends on declaration order that nothing enforces.
The three bugs above are all symptoms of that shape, and the fixes treat the
symptoms.

The right change is a route table — method, an anchored pattern, a handler —
with dispatch that fails loudly when two patterns overlap. It would make the
auth boundary explicit, make each handler testable on its own, and make the
class of bug above structurally impossible rather than individually guarded.

It is not done here because it is 1,313 lines of handler movement, and the right
time to do it is on purpose with someone watching, not unattended. The 780 tests
make it safe to attempt; they do not make it a good idea to attempt unannounced.

---

## Checks

| | before | after |
|---|---|---|
| design-hub | 767 | **780** |
| design-ai | 341 | **341** |

Six deliberate regressions were introduced and all six were caught: the DELETE
catch-all restored (10 failures), the `/respond` matcher unanchored, doctor's
old parser restored (named the exact input that diverged), and three from the
earlier round.

Beyond the suites: `runner.mjs --smoke` passes 12/12 against the live Hub,
Linear and git; `doctor.mjs` reads every real credential; `attach-report.mjs`
plans exactly what it planned before the refactor.
