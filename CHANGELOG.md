# Changelog

All notable changes are documented here. This project follows
[SemVer](https://semver.org/).

## [2.0.0] — 2026-04-19

First public release. Includes the v1 auto-learning loop plus two new
advisory layers: explicit strategy weights and a bounded personality
vector.

### Added
- **Strategy weight table** — six presets (`balanced`, `innovate`,
  `harden`, `steady-state`, `early-stabilize`, `repair-only`) rendered
  into the digest as explicit probabilities, e.g.
  `repair=5% optimize=10% innovate=80% explore=5%`.
- **Auto `early-stabilize`** — fresh installs (≤ 5 recorded sessions)
  default to prioritizing repair over innovation. Graduates to
  `balanced` on the sixth session.
- **PersonalityState** — five floats (`rigor`, `creativity`,
  `verbosity`, `risk_tolerance`, `obedience`) persisted to
  `~/.pi/evolver/personality.json`. Nudged ≤ ±0.05 per session based on
  outcome; hard-clamped to `[0.10, 0.90]`. Every change logged.
- **`pi-evolver personality`** subcommand — `personality` to view,
  `personality reset` to restore defaults.
- **Digest injection** now carries both the strategy weights and the
  personality line into Pi's system prompt.

### Changed
- Digest renderer restructured: `Intent mix:` line under strategy,
  `## Session personality` section under that.
- `pi-evolver run` now respects the kill-switch (fix — v1 bypassed).
- `pi-evolver status` shows strategy weights and personality alongside
  the existing summary.

### Fixed
- `pi-evolver run` previously wrote the digest even when the
  kill-switch was set. It now short-circuits with a clear message.

### Safety
- All personality updates are bounded by `PERSONALITY_NUDGE = 0.05`.
- Drift-toward-defaults has a half-life of ~20 sessions.
- Kill-switch is honored at three levels: the daemon, the CLI `run`,
  and the extension's hook handlers.

## [1.0.0] — internal

Internal pre-release that powered the design of v2. Recorded metadata-
only events, generated a rolling Markdown digest, injected it into the
system prompt at `before_agent_start`, and gated promotion behind an
explicit CLI command. No public release.
