# Ideas considered

This doc is where we park ideas that *could* extend pi-evolver, so
future contributors don't waste time re-pitching ones we already
evaluated and declined. It is also where the hard limits on scope are
written down.

## The design contract (hard limits)

pi-evolver is **auto-learning, manual promotion**. Ideas that move it
away from that contract will be declined, regardless of how clever.

Concretely that means:

- ❌ No auto-modification of code, prompts, or skills
- ❌ No network calls of any kind
- ❌ No recording of prompt text or tool-call content
- ❌ No unbounded feedback loops (every parameter that adjusts itself
  has hard clamps)
- ❌ No self-tampering integrity checks (plain readable source, always)
- ❌ No central server, hub, or peer-to-peer sync

Every one of these lines exists because crossing it is how "self-
evolving" systems quietly break themselves. pi-evolver is the small
thing that avoids the big failure mode.

## Scoring rubric

Each candidate idea gets three numbers:

- **Value** (1–5): how much it would improve pi-evolver in practice
- **Effort** (1–5): lines of code plus risk of bugs
- **Fit**   (1–5): how well it matches pi-evolver's architecture

Rule of thumb: `Value × Fit ≥ 12` and `Effort ≤ 2` ships. Anything else
needs an explicit justification in the PR.

---

## Considered — worth revisiting

### 🟡 Structured failure classification
**Value 4 / Effort 3 / Fit 3 = 12**

Today we group errors by hashing a normalized form of the error
message (`errsig:<8-char-sha>`). That catches textual repetition but
misses semantic repetition: two different exception strings that
describe the same failure mode collapse to different buckets.

A smarter classifier would tag failures by mode — `test_failure:timeout`,
`validation_failed:missing_module`, `destructive_edit:secrets` — so the
digest can say _"the same **class** of failure keeps recurring,"_ which
is more actionable than _"the same string keeps recurring."_

**Worth it when:** you have 500+ events and `pi-evolver tail 100` is
full of `errsig:*` that look different but feel like the same bug.

### 🟡 Scheduled reflection every N sessions
**Value 3 / Effort 3 / Fit 4 = 12**

Every N sessions (say 5), summarize what's been tried and store a
short reflection note that the next session's prompt sees. Gives the
digest a narrative arc on top of the raw counters.

**Worth it when:** the current crash-log-style digest feels too
mechanical. Candidate implementation: ~50 lines, bring-your-own-LLM
for the summarization step, off by default.

### 🟡 Synonym expansion for signals
**Value 3 / Effort 2 / Fit 3 = 9** (borderline)

Treat `error`, `exception`, and `failed` as one bucket when computing
recurrence. A small hand-written synonym table does the job.

**Worth it when:** `pi-evolver status` surfaces two different recurring
signals that clearly describe the same thing.

### 🟡 Weekly digest email/notification
**Value 2 / Effort 1 / Fit 4 = 8** (borderline)

A `pi-evolver weekly-report` command that emits the week's digest to
stdout, suitable for piping into an email script or a local
notification. Doesn't change behavior, just improves observability.

### 🟡 Claude Code adapter
**Value 4 / Effort 3 / Fit 3 = 12**

Port the extension to Claude Code's hook system. The signal
extraction, daemon, CLI, and digest format all transfer unchanged —
only the ~250-line extension file needs to be rewritten against a
different hook API.

**Worth it when:** someone wants to use this on Claude Code. The
upstream hook surface is stable enough to target.

### 🟡 Linux scheduling
**Value 2 / Effort 1 / Fit 5 = 10**

Currently the installer registers a macOS launchd job. On Linux we
need an equivalent — most likely a systemd user timer template, or a
generic "run this every 6 hours" wrapper.

### 🟡 Smarter `errsig` normalizer
**Value 2 / Effort 2 / Fit 4 = 8**

The current normalizer replaces paths with `/PATH` and numbers with
`N`. It's adequate but crude. A better one might normalize hashes,
UUIDs, timestamps, and common error-message prefixes. Low ceiling on
value but cheap to improve incrementally.

---

## Declined

These have all been considered and deliberately left out. A PR adding
any of them will be closed unless it addresses the specific concern
below.

### ❌ Automatic code or prompt modification
Violates the core contract. See "hard limits" at the top.

### ❌ LLM-in-the-loop pattern synthesis
"Use the model to generate new skills from recent patterns" sounds
appealing. It requires:

- hundreds of successful sessions before the synthesized output is
  useful
- a human review step anyway (nobody wants to ship model-generated
  skills blind)
- a cost budget

`pi-evolver promote` is the cheaper alternative: a 30-second human
glance per promotion, no LLM call. The one hand-written draft it
produces is better than what a model would hallucinate off a handful
of events.

### ❌ Network sync of events or digests
Every networked feature adds an attack surface. For a single-user
tool, sync gives you no value and one more thing to go wrong.

### ❌ Central registry of "community" signals or strategies
Same reasoning as network sync, plus the coordination problem. If a
strategy works for you, write it locally.

### ❌ Embedding-based similarity between events or skills
Every implementation of this we've considered either (a) requires
network calls to an embedding API, or (b) bundles a local model that
makes the installer heavy. The model-driven semantic matching that Pi
already does is strictly better for a single user.

### ❌ Parallel "agent personality graph" or "skill graph"
Graphs are appealing on whiteboards. In practice, they replace readable
JSONL with something you need a viewer to inspect. `events.jsonl` can
be read with `less`. Keep it that way.

### ❌ Self-tampering integrity checks
If you don't trust the code on disk, you don't run the tool. An
integrity check that phones home or verifies its own source is added
attack surface, not added safety.

### ❌ Per-project personality
"Let the daemon keep different personalities per cwd." Interesting —
and the wrong decision unit. You don't want the model to behave
differently between two projects in ways you didn't explicitly set.
Per-project configuration belongs in Pi's own skills/settings, not in
a background daemon.

### ❌ Larger personality surface (more than 5 traits)
The five traits we ship cover the useful axes: stability vs. speed,
familiarity vs. novelty, terseness vs. detail, risk, and obedience.
Adding a 6th trait buys almost nothing and doubles the cognitive load
of reading the digest.

### ❌ Unbounded nudge magnitudes
The ±0.05 cap is the single most important safety property this tool
has. Asking for "just ±0.10 when confidence is high" is asking for the
failure mode we're designing against.

---

## How to add a new idea

1. Score it using the rubric above.
2. If it lands under "worth revisiting," open an issue with the score
   and a concrete trigger (*"add this when X"*).
3. If it crosses a hard limit, don't open the PR — open an issue
   explaining why the hard limit should change. That's a much bigger
   conversation and deserves its own thread.

---

## A note on scope

Every surviving line of pi-evolver exists because it earned its place.
Every declined idea exists in this doc for the same reason: someone
had a plausible-sounding pitch, and we checked it against the rubric,
and it didn't clear the bar.

The project stays small on purpose. _"One idea, done well"_ beats
_"five ideas, all half-finished"_ — and it's the only way to keep a
background daemon trustworthy enough to leave running.
