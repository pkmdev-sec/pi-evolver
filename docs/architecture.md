# Architecture

A detailed walk-through of every moving part. Read this if you're
thinking of forking, porting, or auditing.

## Component map

```mermaid
%%{init: {
  "theme":"base",
  "themeVariables": {
    "fontFamily":"ui-sans-serif, -apple-system, Segoe UI, sans-serif",
    "fontSize":"13px",
    "actorBkg":"#E0E7FF",
    "actorBorder":"#6366F1",
    "actorTextColor":"#1E293B",
    "signalColor":"#334155",
    "signalTextColor":"#334155",
    "labelBoxBkgColor":"#FEF3C7",
    "labelBoxBorderColor":"#F59E0B",
    "labelTextColor":"#78350F",
    "noteBkgColor":"#F5F3FF",
    "noteBorderColor":"#A78BFA",
    "noteTextColor":"#5B21B6",
    "activationBkgColor":"#F1F5F9",
    "activationBorderColor":"#64748B"
  }
}}%%
sequenceDiagram
    autonumber
    participant U as User
    participant PI as Pi runtime
    participant EXT as Extension<br/>evolver.ts
    participant FS as ~/.pi/evolver/
    participant DAE as daemon.mjs<br/>(launchd, 6 h)

    U->>PI: start session
    PI->>EXT: session_start
    EXT->>FS: (init in-memory stats)

    PI->>EXT: before_agent_start
    EXT->>FS: read digest.md
    EXT-->>PI: systemPrompt += digest<br/>(only if non-trivial)

    loop turn
        PI->>EXT: tool_execution_start
        PI->>EXT: tool_result
        EXT->>EXT: count calls,<br/>hash any errors
    end

    U->>PI: exit (Ctrl+C, /new, /fork)
    PI->>EXT: session_shutdown
    EXT->>FS: append 1 event to events.jsonl
    EXT->>FS: append line to evolver.log

    Note over DAE,FS: (later, up to 6 h) launchd fires daemon
    DAE->>FS: read last 500 from events.jsonl
    DAE->>DAE: analyzeEvents()<br/>streaks · saturation · errsigs
    DAE->>FS: rewrite digest.md + digest.json
    DAE->>FS: updatePersonality()<br/>nudge ≤ ±0.05,<br/>clamp [0.10, 0.90]
    DAE->>FS: append line to evolver.log
```


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

```mermaid
%%{init: {
  "theme":"base",
  "themeVariables": {
    "fontFamily":"ui-sans-serif, -apple-system, Segoe UI, sans-serif",
    "fontSize":"13px",
    "primaryColor":"#E0E7FF",
    "primaryTextColor":"#1E293B",
    "primaryBorderColor":"#6366F1",
    "lineColor":"#64748B",
    "clusterBkg":"#FAFBFF",
    "clusterBorder":"#CBD5E1",
    "edgeLabelBackground":"#FFFFFF"
  }
}}%%
flowchart TD
    START([ analyze events ]) --> Q1{"consecutive<br/>failures ≥ 3?"}
    Q1 -- yes --> S_INNOVATE["<b>innovate</b><br/><sub>80% innovate · 5% explore</sub><br/><sub>break the loop</sub>"]
    Q1 -- no --> Q2{"consecutive<br/>empty ≥ 3?"}
    Q2 -- yes --> S_STEADY["<b>steady-state</b><br/><sub>55% repair · 15% explore</sub><br/><sub>stop spinning</sub>"]
    Q2 -- no --> Q3{"signal<br/>saturated?"}
    Q3 -- yes --> S_HARDEN["<b>harden</b><br/><sub>40% repair · 35% optimize</sub><br/><sub>stabilize first</sub>"]
    Q3 -- no --> Q4{"total<br/>events ≤ 5?"}
    Q4 -- yes --> S_EARLY["<b>early-stabilize</b><br/><sub>60% repair · 3% explore</sub><br/><sub>prove stability first</sub>"]
    Q4 -- no --> S_BAL["<b>balanced</b><br/><sub>50% innovate · 10% explore</sub><br/><sub>default</sub>"]

    classDef decision fill:#FEF3C7,stroke:#F59E0B,stroke-width:2px,color:#78350F
    classDef strategy fill:#E0E7FF,stroke:#6366F1,stroke-width:2px,color:#1E293B
    classDef terminal fill:#F1F5F9,stroke:#94A3B8,stroke-width:1.5px,color:#334155

    class Q1,Q2,Q3,Q4 decision
    class S_INNOVATE,S_STEADY,S_HARDEN,S_EARLY,S_BAL strategy
    class START terminal
```


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
