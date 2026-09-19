# The board, audited against Material 3 Expressive

19 September 2026. A self-audit of `frontend/index.html` — every number below
was measured from the stylesheet, not estimated.

Material 3 Expressive is Google's 2025 revision of Material 3. Its argument is
that legibility and emotion are not in tension: clearer hierarchy, bolder
shape, and motion that explains what changed all make an interface *easier* to
read, not merely nicer. That is the lens here.

**The board is not badly designed.** It is restrained, consistent and dense in
a way that suits a working tool, and its colour already carries meaning rather
than decoration. What it lacks is a *system* — the values are chosen one at a
time — and it has three accessibility faults that would fail an audit anywhere.

---

## What is measurably wrong

### 1. Nothing shows keyboard focus. This is the worst one.

```
focus-visible rules in the stylesheet: 0
```

Every control is a real `<button>`, so the board is fully keyboard-reachable —
and completely unusable that way, because nothing indicates where you are.
WCAG 2.4.7, Level AA.

It matters more here than on most pages because the controls are consequential
and adjacent: **Dismiss**, **No design** and **Mark done** sit in one row, and
two of them write to Linear. Tabbing blind through that row is a real way to
close somebody else's issue.

### 2. Two text colours fail contrast

| token | value | on `--bg` | verdict |
|---|---|---|---|
| `--text` | `#e4e4e0` | 15.03:1 | passes comfortably |
| `--text-muted` | `#7a7a74` | **4.44:1** | fails AA for body text (needs 4.5) |
| `--text-dim` | `#444442` | **1.96:1** | fails everything |

`--text-muted` is the colour of **every button label** at 12px — not large
text, so 4.5:1 applies and it misses. `--text-dim` is used for brand counts and
the skipped pill; at 1.96:1 it is decoration that happens to contain words.

Both are near-misses in effort terms. `--text-muted: #8f8f88` reaches 5.6:1 and
looks almost identical.

### 3. Five run states share three colours

```css
--run-error:   #e8846f;
--run-stalled: #e8846f;   /* identical */
--run-working: #f0b84a;
--run-waiting: #f0b84a;   /* identical */
--run-done:    #6fbf8b;
```

`runState()` carefully distinguishes **error**, **stalled**, **working**,
**waiting** and **done** — and then the board paints error the same as stalled,
and working the same as needs-you. The pill text differs, so the information is
not lost, but at a glance across sixty cards colour is the only channel doing
work, and it is answering a coarser question than the one the code asked.

These are genuinely different: *stalled* is "nothing is coming, this is on
you", *error* is "it tried and broke". *Waiting* needs a human; *working* needs
patience. Four states, two of which are actionable, collapsed into two colours.

This is the one finding that is a information-design bug rather than a polish
item.

### 4. No reduced-motion support

```
prefers-reduced-motion rules: 0
```

Currently low impact — there are only 6 transitions and all are ≤ 0.1s. It
becomes mandatory the moment any Expressive motion is added, which is the point
of this audit.

---

## Where the system is missing

### Type: 8 sizes, no scale

55 `font-size` declarations drawing on 8 distinct values (10, 11, 12, 13, 14,
15, 16, 18px), each chosen where it was needed. M3E's type scale is the single
biggest lever it offers, because hierarchy is what makes a dense board scannable.

Sizes chosen individually drift: the card title (14px) and a brand header
(15px) are one step apart, which is not enough for the eye to read them as
different *kinds* of thing.

**A scale, with roles rather than sizes:**

```css
--type-display: 22px/1.2 700;   /* brand headers — the only thing that shouts */
--type-title:   15px/1.3 600;   /* card titles */
--type-body:    13px/1.45 400;  /* prose, notes, detail */
--type-label:   12px/1 500;     /* buttons, controls */
--type-meta:    11px/1.3 500;   /* counts, timestamps, capabilities */
```

Five roles instead of eight sizes, and a bigger jump between display and title —
which is what makes a brand section read as a section rather than as a slightly
larger card.

### Shape: 9 radii, no scale

```
1px  2px  4px  5px  6px  8px  10px  50%  100px
```

M3E treats shape as a *signal*, not a finish: rounder means softer and more
interactive, squarer means structural. Nine values chosen ad hoc cannot signal
anything.

```css
--shape-xs: 4px;    /* chips, dots, bars */
--shape-sm: 8px;    /* buttons, inputs */
--shape-md: 12px;   /* cards */
--shape-lg: 20px;   /* drawers, panels */
--shape-full: 999px;/* pills */
```

Card radius moving 8px → 12px and buttons 6px → 8px is small in isolation and
is most of what makes an interface read as current.

### Motion: 6 transitions, all linear

M3E's motion system is the part most people notice. Two easing curves do nearly
all of it:

```css
--ease-standard:   cubic-bezier(.2, 0, 0, 1);      /* things moving in place */
--ease-emphasized: cubic-bezier(.3, 0, 0, 1);      /* things arriving/leaving */
--dur-short:  120ms;
--dur-medium: 240ms;
```

Where it would earn its place here, in order:

1. **The run-state pill changing** — a card going from Working to Needs you is
   the most important event on the board and currently just swaps text.
2. **Cards leaving on dismiss** — they vanish; a short collapse explains where
   it went and makes the Undo discoverable.
3. **Drawer open/close** — `<details>` snaps.

### Touch targets

`.btn` is `padding: 5px 12px` at `font-size: 12px` — about **26px** tall.
Material asks for 48px, WCAG 2.5.8 for 24px minimum. It clears the floor and
misses the target, and you have used this board on a phone, where the row of
six card actions is the hardest thing to hit.

`min-height: 32px` with unchanged padding keeps the density and helps.

---

## What is already right, and should not be "fixed"

- **Colour carries meaning.** One token per run state, read by the pill, the
  card outline and the console. That is the M3 colour-role idea, arrived at
  independently, and the comment in the stylesheet says exactly why.
- **Density.** This is a dashboard for sixty cards. M3E's larger default
  spacing would be wrong here; the expressive gain should come from type and
  shape, not from padding everything to 16px.
- **The dark surface ramp.** `--bg` → `--surface` → `--surface-2` → `--surface-3`
  is already M3's elevation-by-tone model.
- **Restraint in the card.** Title, pill, one primary action. Adding
  ornamentation would cost more than it returns.

---

## What I would do, in order

| | change | why it is first | risk |
|---|---|---|---|
| 1 | `:focus-visible` on every control | a keyboard user cannot use the board at all | none |
| 2 | lift `--text-muted` and `--text-dim` | two contrast failures, one severe | none |
| 3 | split the five run-state colours | the board cannot show a distinction the code makes | low |
| 4 | type scale as roles | the largest readability gain available | low |
| 5 | shape scale | most of what makes it read as current | low |
| 6 | motion tokens + reduced-motion | explains state changes rather than announcing them | low |
| 7 | 32px min touch target | phone use is real here | low |

1–3 are corrections. 4–7 are the Expressive part, and none of them change a
single line of behaviour — every one is a stylesheet change, which is why the
behavioural tests still hold afterwards.

## What has been done

**1, 2, 3, 6 (partly) and 7 are in.** The corrections first, because they were
faults rather than preferences:

- `:focus-visible` on everything, with the destructive controls carrying their
  own ring colour
- `--text-muted` 4.44 → **5.89:1**, `--text-dim` 1.96 → **4.56:1**
- five run states, five colours: stalled is magenta against error's red-orange,
  waiting is blue against working's amber — the two pairs that were identical
  are now the two pairs that most needed telling apart
- `prefers-reduced-motion` honoured, and motion tokens declared so the next
  thing that animates does not invent its own curve
- `.btn` gains `min-height: 32px` and an 8px radius

**`test/a11y.test.mjs` holds all of it down.** Thirteen checks that compute
contrast from the tokens rather than trusting a comment, assert the five states
stay distinct *and* far enough apart to tell apart, and require a real
`outline:` shorthand rather than a lone `outline-color` that paints nothing.
Ten deliberate regressions were introduced and ten were caught — including
re-introducing the exact 1.96:1 value.

**Not yet done: the type scale (4) and the full shape scale (5).** Both touch
every component rather than the token block, so they are worth doing as their
own pass with the board in front of you. The audit above has the proposed
scales.

One thing the contrast fix exposed: `--text-muted` and `--text-dim` are now
close together, because there is not much room below 4.5:1 on this background.
Three greys was always the wrong way to get three levels of emphasis — the
third level should come from the type role. That is an argument for doing (4).

## What I did not do

**No component library.** `CLAUDE.md` is unambiguous: no build step, no
dependencies. Material Web Components would mean both. Everything above is
plain CSS custom properties, which is how the stylesheet already works.

**No layout change.** The three-column board, the sidebar and the drawers are
sound. An audit that returns "redesign it" is usually an audit that did not
look closely.
