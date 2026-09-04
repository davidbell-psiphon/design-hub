# Design Hub — Update Brief

Paste this into the Design Hub chat. It describes what the Hub needs to become, given decisions made on the Design AI side.

---

## What changed

The Design AI is now six agents in two tracks, triggered by Linear labels, writing into per-project Figma files. The Hub is its command centre — the single surface where I see state and make decisions.

Three decisions constrain the Hub build:

1. **Nothing is automatic.** A scheduled job gathers Linear issues so I never open Linear. It does not start work. Every agent run begins because I trigger it.
2. **The Hub stays generic.** It knows sessions, states, projects, prompts. It must not know what a "gate" or "QA agent" is. A Social Media agent system plugs into the same surface later without Hub changes.
3. **Brand is the container.** Everything organized by brand. "Design AI" is not a top-level item — it is the thing doing work inside every brand.

---

## The view

Brand buckets as the primary structure. Within each brand, three sections in this order:

```
CONDUIT
  In flight        agent working — which agent, which stage
  Queued           in Linear TODO, not yet triggered
  Backlog          candidates

RYVE
  ...

PSIPHON VPN
  ...

FORGE
  ...
```

Cards are **colour-coded per brand** — not a small chip, the card itself carries the brand colour. Brand colours:

| Brand | Colour |
|-------|--------|
| Conduit | `#7E67A4` |
| Psiphon VPN | `#D54028` |
| Ryve | `#206CCC` |
| Forge | `#BE5135` |

A persistent side panel shows all in-flight agent work across every brand, grouped App / Website. That is the "what is running right now" answer without breaking brand organization.

---

## Card contents

Each card needs:

- Linear issue ID and title
- Which stage: Research / Design / QA / Waiting on me
- Whether it needs my decision — this is the single most important signal
- Link to the Linear issue
- Link to the Figma section once it exists
- Track (app or web) — derived from the Linear team

---

## The trigger

Each card in Queued and Backlog needs a trigger button. Pressing it applies the Linear label `design-ai:go` to that issue.

That is the entire mechanism. The agent watches for that label. The Hub's job is to make applying it a one-tap action instead of a trip into Linear.

A second button on cards waiting at the human gate applies `design-ai:qa` — meaning "my Figma work is done, run QA."

**The three labels, for reference:**

| Label | Meaning |
|-------|---------|
| `design-ai:go` | Start work — research then design |
| `design-ai:qa` | Human gate passed, run QA |
| `no-research` | Skip research, mockup from description only |

`no-research` should be a toggle on the card before triggering, not a separate button.

---

## The scheduled job

Weekly, not daily. Design issues get created Tuesday and Thursday, so run **Wednesday and Friday morning**.

What it does: pull every Linear issue assigned to me, across all teams, in Backlog or TODO. Write them into the Hub so they appear in the right brand bucket. That is all — it gathers, it does not trigger.

The point is that I never have to open Linear to find design work. Linear is a black hole; the Hub is the readable surface.

---

## Integration surface

Keep this generic so other agent systems can use it.

**Agent writes state:**
```
POST /session
{
  "system": "design-ai",
  "session_id": "conduit/wallet-flow/design",
  "brand": "conduit",
  "track": "app",
  "linear_issue": "CON-142",
  "status": "waiting",
  "stage": "Design",
  "prompt": "Two direction options ready — which proceeds?",
  "figma_url": "...",
  "updated_at": "..."
}
```

**Hub returns my decision:**
```
GET /session/{id}/response
→ { "response": "Option B", "responded_at": "..." }
```

The `system` field is what keeps it generic. A Social Media agent posts the same shape with `"system": "social-ai"` and the Hub groups it without knowing anything about social media production.

---

## Open questions for the Hub build

1. Does the Worker have a write endpoint yet, or is it read-only?
2. Extend the existing D1 schema, or a separate table for agent-written sessions?
3. How does my decision get back to the agent — polling on next run is probably simplest given the agent is not always running.
4. Auth for the write endpoint — the agent runs on my machine, so a shared secret in an env var is likely enough.

---

## What not to build

- Gate logic, agent role names, QA classifications — anything Design-AI-specific couples the Hub to one system
- Design rendering — link to Figma, do not embed
- Agent configuration — that lives in the design-ai repo

The Hub is a session board with trigger buttons. Keep it that.
