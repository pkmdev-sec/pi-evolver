# Architecture

A detailed walk-through of every moving part. Read this if you're
thinking of forking, porting, or auditing.

## Component map

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)"  srcset="../assets/diagrams/sequence-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="../assets/diagrams/sequence-light.svg">
    <img alt="session lifecycle: extension writes events, daemon rewrites digest" src="../assets/diagrams/sequence-light.svg" width="100%">
  </picture>
</p>



## Data model

### An event

```typescript
type Event = {
  v: 1;                                        // schema version
  timestamp: string;                           // ISO 8601 UTC
  session_id: string;                          // 12-char hex, generated per session
  cwd: string;                                 // working dir at session start
  session_file: string | null;                 // Pi's session log path (if any)
  duration_ms: number;                         // milliseconds
  tool_calls: number;                          // total tool_result events seen
  tool_errors: number;                         // tool_results flagged as errors
  edits: number;                               // count of edit or write tool calls
  long_bash: number;                           // bash calls exceeding LONG_BASH_MS
  signals: string[];                           // derived signals (see below)
  outcome: 'pass' | 'crash' | 'partial' | 'empty';
  summary: string;                             // one-line human-readable
};
```

### A signal

A short string describing one observable pattern in the session. Current
vocabulary:

| Signal                   | When derived                                     |
| ------------------------ | ------------------------------------------------ |
| `no_tool_calls`          | session ended with 0 tool calls                  |
| `tool_error_rate:high`   | ≥30% of tool calls returned an error             |
| `long_bash_commands`     | ≥2 bash calls ran longer than 60 s               |
| `edit_churn:high`        | ≥10 edit or write calls                          |
| `edit_churn:med`         | 3–9 edit or write calls                          |
| `crashed`                | session terminated abnormally                    |
| `short_session`          | duration < 30 s                                  |
| `long_session`           | duration ≥ 30 min                                |
| `errsig:<hash>`          | 8-char SHA-256 prefix of a normalized error msg  |

`errsig:*` signals are how we spot recurrence. The normalizer replaces
paths with `/PATH` and numbers with `N`, so
`"TypeError at /Users/alice/foo.ts:42"` and
`"TypeError at /Users/bob/foo.ts:99"` collapse to the same bucket.

### Personality

```typescript
type PersonalityState = {
  type: 'PersonalityState';
  rigor: number;           // [0.10, 0.90]
  creativity: number;
  verbosity: number;
  risk_tolerance: number;
  obedience: number;
  updated_at: string | null; // ISO 8601
};
```

### Digest

The human-readable `digest.md` is generated from the analysis object.
`digest.json` contains the same analysis as JSON (for tooling).

Neither is used by the extension — the extension reads `digest.md`
verbatim and appends it to the system prompt after `before_agent_start`.

## The 6-hour loop

`launchd` invokes `node ~/.pi/evolver/daemon.mjs` every 21,600 seconds
(configurable via the plist's `StartInterval`). The daemon:

1. Checks `isDisabled()` — if true, exits immediately.
2. Calls `rotateEventsIfNeeded()` — if `events.jsonl` exceeds 10,000 lines, rolls all but the last 1,000 into `events.archive.jsonl`.
3. Calls `readRecentEvents(500)` — reads the tail 500 events.
4. Calls `analyzeEvents()` — computes streaks, saturation, errsig frequency, strategy, candidates.
5. Calls `writeDigest(analysis)` — which also calls `updatePersonality(analysis)`.
6. Logs one line to `evolver.log` and exits.

The whole run takes <100ms on a laptop with 500 events.

## The strategy decision

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)"  srcset="../assets/diagrams/strategy-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="../assets/diagrams/strategy-light.svg">
    <img alt="strategy decision tree: which preset is picked from recent event patterns" src="../assets/diagrams/strategy-light.svg" width="70%">
  </picture>
</p>



The resulting strategy object includes:

```json
{
  "repair": 0.20,
  "optimize": 0.20,
  "innovate": 0.50,
  "explore": 0.10,
  "repairLoopThreshold": 0.5,
  "description": "Normal operation. Steady growth with stability."
}
```

## The personality update

```
raw = proposeNudges(analysis)           // analysis-driven signal

for each trait not already nudged:
  diff = default - current[trait]
  if |diff| > 0.01:
    raw[trait] = sign(diff) * min(|diff|/2, 0.05/2)   // drift toward default

for each trait:
  raw[trait] = clip(raw[trait], -0.05, +0.05)
  next[trait] = clamp(current[trait] + raw[trait], 0.10, 0.90)

persist, log every changed trait
```

Half-life is ~20 sessions: each idle session moves a drifted trait
halfway back toward its default, capped at ±0.025.

## Failure modes and what we do about them

| What could go wrong                             | Mitigation                                            |
| ----------------------------------------------- | ----------------------------------------------------- |
| Extension throws in a hook                      | Every handler wrapped in try/catch; errors logged     |
| Corrupted line in `events.jsonl`                | `readRecentEvents` skips malformed lines              |
| `digest.md` not yet generated                   | `before_agent_start` returns `undefined` (no effect)  |
| Daemon runs while extension is writing          | `appendFileSync` is atomic for our line sizes (<4 KB) |
| Personality drifts somewhere weird              | Hard clamps + `personality reset` + audit log         |
| User accidentally runs the tool in a sensitive dir | No content recorded; only metadata                 |
| User wants to nuke everything                   | `./scripts/uninstall.sh --all`                        |

## Why this design

The big decision is "record metadata only, never content, derive
signals from counts + error hashes." It has three consequences:

1. **Privacy by construction.** The events file is small, readable, and
   contains nothing you couldn't post on Twitter.
2. **Debuggable patterns.** `pi-evolver tail 20` shows you exactly what
   the daemon will see. No embedding magic.
3. **Bounded surface area.** Five signals and a hash. When the digest
   suggests something you disagree with, you can trace it back to
   specific events in under a minute.

The alternative — recording the actual session content and running LLM
clustering over it — would give you richer suggestions but at the cost
of readability, privacy, and every self-improvement project's favorite
failure mode: silent drift nobody can audit.
