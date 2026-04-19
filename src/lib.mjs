// Shared library for pi-evolver. Used by both the daemon and the CLI.
// The Pi extension inlines its own copy (TypeScript, no imports).
//
// Design: all state lives under ~/.pi/evolver. Pure file I/O, no network.
// Every function is defensive — a corrupted events.jsonl line is skipped, not
// thrown, so one bad write can never brick the system.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const HOME = os.homedir();
export const EVOLVER_DIR = path.join(HOME, '.pi', 'evolver');
export const EVENTS_FILE = path.join(EVOLVER_DIR, 'events.jsonl');
export const EVENTS_ARCHIVE = path.join(EVOLVER_DIR, 'events.archive.jsonl');
export const DIGEST_FILE = path.join(EVOLVER_DIR, 'digest.md');
export const DIGEST_JSON = path.join(EVOLVER_DIR, 'digest.json');  // machine-readable
export const LOG_FILE = path.join(EVOLVER_DIR, 'evolver.log');
export const DISABLE_FILE = path.join(EVOLVER_DIR, 'DISABLED');
export const PERSONALITY_FILE = path.join(EVOLVER_DIR, 'personality.json');

// --- v2: Strategy presets ---
// Distribution over intents plus a repair-loop-tolerance threshold. The
// per-intent weights sum to 1.0 and are rendered verbatim into the digest
// so the model can read "lean innovate 80% / explore 5%" instead of just
// a category label.
export const STRATEGIES = {
  balanced:          { repair: 0.20, optimize: 0.20, innovate: 0.50, explore: 0.10, repairLoopThreshold: 0.5, description: 'Normal operation. Steady growth with stability.' },
  innovate:          { repair: 0.05, optimize: 0.10, innovate: 0.80, explore: 0.05, repairLoopThreshold: 0.3, description: 'System is stable. Maximize new features and capabilities.' },
  harden:            { repair: 0.40, optimize: 0.35, innovate: 0.20, explore: 0.05, repairLoopThreshold: 0.7, description: 'After a big change. Focus on stability and robustness.' },
  'repair-only':     { repair: 0.80, optimize: 0.18, innovate: 0.00, explore: 0.02, repairLoopThreshold: 1.0, description: 'Emergency. Fix everything before doing anything else.' },
  'early-stabilize': { repair: 0.60, optimize: 0.22, innovate: 0.15, explore: 0.03, repairLoopThreshold: 0.8, description: 'First few sessions. Prioritize fixing existing issues before innovating.' },
  'steady-state':    { repair: 0.55, optimize: 0.25, innovate: 0.05, explore: 0.15, repairLoopThreshold: 0.9, description: 'Evolution saturated. Maintain existing capabilities. Explore for new directions.' },
};

// First N sessions auto-select early-stabilize (matches Evolver's cycle<=5 rule).
export const EARLY_STABILIZE_CYCLES = 5;

// --- v2: PersonalityState ---
// Five traits in [PERSONALITY_MIN, PERSONALITY_MAX]. We clamp hard because
// this is the first step toward anything resembling "auto-modifying" behavior
// and we want bounded influence.
export const PERSONALITY_TRAITS = ['rigor', 'creativity', 'verbosity', 'risk_tolerance', 'obedience'];
export const PERSONALITY_MIN = 0.10;
export const PERSONALITY_MAX = 0.90;
export const PERSONALITY_NUDGE = 0.05; // max absolute change per session
export const PERSONALITY_DEFAULTS = {
  rigor: 0.70,          // insist on tests + validation, vs. move fast
  creativity: 0.35,     // stay close to patterns, vs. branch out
  verbosity: 0.25,      // terse, vs. explain-everything
  risk_tolerance: 0.40, // attempt risky edits (migrations, refactors)
  obedience: 0.85,      // stick strictly to user instructions, vs. add improvements
};

// Keep events.jsonl bounded. At 10k lines we roll the first 9k into archive.gz
// (never deleted — we might want long-range analysis later).
export const EVENTS_SOFT_LIMIT = 10_000;
export const EVENTS_KEEP_AFTER_ROTATE = 1_000;

// The digest reads at most this many recent events.
export const DIGEST_WINDOW = 500;

// Signal saturation threshold: if a signal shows up in ≥N of the last 8
// sessions, suggest suppressing it.
export const SATURATION_THRESHOLD = 4;
export const SATURATION_WINDOW = 8;

// Consecutive-failure threshold that flips the suggestion to "innovate".
export const FAILURE_LOOP_THRESHOLD = 3;
export const EMPTY_LOOP_THRESHOLD = 3;

export function ensureDirs() {
  fs.mkdirSync(EVOLVER_DIR, { recursive: true });
}

export function isDisabled() {
  if (process.env.PI_EVOLVER_DISABLED === '1') return true;
  return fs.existsSync(DISABLE_FILE);
}

export function logLine(msg) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch { /* never throw from logger */ }
}

// --- event I/O ---

/**
 * Append one event record to events.jsonl atomically-enough for our use case.
 * fs.appendFileSync on macOS is write(2) with O_APPEND → atomic for <4KB writes.
 * Our event records are ~300 bytes. Safe.
 */
export function appendEvent(event) {
  ensureDirs();
  const line = JSON.stringify(event) + '\n';
  fs.appendFileSync(EVENTS_FILE, line, 'utf8');
}

/**
 * Read the last N events from events.jsonl. Malformed lines are skipped.
 * Returns newest-last.
 */
export function readRecentEvents(limit = DIGEST_WINDOW) {
  if (!fs.existsSync(EVENTS_FILE)) return [];
  const raw = fs.readFileSync(EVENTS_FILE, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  const out = [];
  const start = Math.max(0, lines.length - limit);
  for (let i = start; i < lines.length; i++) {
    try { out.push(JSON.parse(lines[i])); }
    catch { /* skip corrupt line */ }
  }
  return out;
}

/**
 * Roll events.jsonl into events.archive.jsonl when it gets too big.
 * Keeps the last N lines in place for the daemon's rolling window.
 */
export function rotateEventsIfNeeded() {
  if (!fs.existsSync(EVENTS_FILE)) return false;
  const raw = fs.readFileSync(EVENTS_FILE, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length < EVENTS_SOFT_LIMIT) return false;
  const keep = lines.slice(-EVENTS_KEEP_AFTER_ROTATE);
  const archive = lines.slice(0, -EVENTS_KEEP_AFTER_ROTATE);
  fs.appendFileSync(EVENTS_ARCHIVE, archive.join('\n') + '\n', 'utf8');
  fs.writeFileSync(EVENTS_FILE, keep.join('\n') + '\n', 'utf8');
  logLine(`rotated ${archive.length} events to ${path.basename(EVENTS_ARCHIVE)}`);
  return true;
}

// --- digest read ---

export function readDigest() {
  if (!fs.existsSync(DIGEST_FILE)) return null;
  try { return fs.readFileSync(DIGEST_FILE, 'utf8'); }
  catch { return null; }
}

export function readDigestJson() {
  if (!fs.existsSync(DIGEST_JSON)) return null;
  try { return JSON.parse(fs.readFileSync(DIGEST_JSON, 'utf8')); }
  catch { return null; }
}

export function digestAgeMs() {
  if (!fs.existsSync(DIGEST_FILE)) return Infinity;
  try {
    const st = fs.statSync(DIGEST_FILE);
    return Date.now() - st.mtimeMs;
  } catch { return Infinity; }
}

// --- event analysis (the "brain") ---

/**
 * Given a list of events (newest-last), compute aggregate patterns.
 *
 * We are deliberately naive here — no ML, no cosine similarity, no embedding.
 * Just counts and streaks over the signals each event records. This is all a
 * single-user system needs, and it's debuggable.
 */
export function analyzeEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return {
      total: 0,
      recentWindow: 0,
      consecutiveFailures: 0,
      consecutiveEmpty: 0,
      signalFrequency: {},
      errsigFrequency: {},
      saturatedSignals: [],
      recurringErrors: [],
      suggestedStrategy: 'balanced',
      strategyReason: 'no events yet',
      strategyWeights: { ...STRATEGIES.balanced },
      outcomeMix: { pass: 0, crash: 0, partial: 0, empty: 0, unknown: 0 },
      candidatesForPromotion: [],
    };
  }

  const recent = events.slice(-SATURATION_WINDOW * 4); // 32 events for stats
  const tail = events.slice(-SATURATION_WINDOW);       // 8 events for saturation

  // Trailing streaks
  let consecutiveFailures = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].outcome === 'crash' || events[i].outcome === 'partial') consecutiveFailures++;
    else break;
  }
  let consecutiveEmpty = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].outcome === 'empty') consecutiveEmpty++;
    else break;
  }

  // Signal frequency across the last 32 events
  const signalFrequency = {};
  const errsigFrequency = {};  // errsig:<hash> → count
  for (const evt of recent) {
    const sigs = Array.isArray(evt.signals) ? evt.signals : [];
    for (const s of sigs) {
      const str = String(s);
      signalFrequency[str] = (signalFrequency[str] || 0) + 1;
      if (str.startsWith('errsig:')) {
        errsigFrequency[str] = (errsigFrequency[str] || 0) + 1;
      }
    }
  }

  // Saturation: signals that appear in ≥ SATURATION_THRESHOLD of last SATURATION_WINDOW
  const tailFreq = {};
  for (const evt of tail) {
    for (const s of (evt.signals || [])) {
      tailFreq[s] = (tailFreq[s] || 0) + 1;
    }
  }
  const saturatedSignals = Object.entries(tailFreq)
    .filter(([_, n]) => n >= SATURATION_THRESHOLD)
    .map(([s, n]) => ({ signal: s, occurrences: n, window: tail.length }));

  // Recurring errors: errsigs that appear ≥ 3 times in last 32 events
  const recurringErrors = Object.entries(errsigFrequency)
    .filter(([_, n]) => n >= 3)
    .map(([sig, count]) => {
      const sample = recent.find(e => (e.signals || []).includes(sig));
      return {
        errsig: sig,
        count,
        sampleSummary: sample?.summary || null,
        lastSeen: sample?.timestamp || null,
      };
    })
    .sort((a, b) => b.count - a.count);

  // Outcome mix
  const outcomeMix = { pass: 0, crash: 0, partial: 0, empty: 0, unknown: 0 };
  for (const evt of recent) {
    const k = outcomeMix[evt.outcome] !== undefined ? evt.outcome : 'unknown';
    outcomeMix[k]++;
  }

  // Suggested strategy. Priority:
  //   1. Consecutive failures  → innovate   (break the loop)
  //   2. Consecutive empties   → steady-state (stop spinning)
  //   3. Signal saturation     → harden      (stabilize first)
  //   4. First EARLY_STABILIZE_CYCLES total events → early-stabilize
  //   5. Otherwise              → balanced
  let suggestedStrategy = 'balanced';
  let strategyReason = 'default — no strong pattern detected';
  if (consecutiveFailures >= FAILURE_LOOP_THRESHOLD) {
    suggestedStrategy = 'innovate';
    strategyReason = `${consecutiveFailures} failures in a row — break the loop, try a different approach`;
  } else if (consecutiveEmpty >= EMPTY_LOOP_THRESHOLD) {
    suggestedStrategy = 'steady-state';
    strategyReason = `${consecutiveEmpty} empty cycles in a row — nothing to do, stop spinning`;
  } else if (saturatedSignals.length > 0) {
    suggestedStrategy = 'harden';
    strategyReason = `signals ${saturatedSignals.map(s => s.signal).join(', ')} are over-represented — stabilize before moving on`;
  } else if (events.length <= EARLY_STABILIZE_CYCLES) {
    suggestedStrategy = 'early-stabilize';
    strategyReason = `only ${events.length} session(s) recorded — prioritize fixing existing issues before innovating`;
  }

  const strategyWeights = { ...(STRATEGIES[suggestedStrategy] || STRATEGIES.balanced) };

  // Candidates for promotion: errsig groups with ≥4 occurrences → "you've hit
  // this enough times to be worth a skill"
  const candidatesForPromotion = Object.entries(errsigFrequency)
    .filter(([_, n]) => n >= 4)
    .map(([sig, count]) => {
      const sample = recent.find(e => (e.signals || []).includes(sig));
      return {
        id: sig.replace('errsig:', 'promote_'),
        errsig: sig,
        count,
        sampleSummary: sample?.summary || null,
      };
    });

  return {
    total: events.length,
    recentWindow: recent.length,
    consecutiveFailures,
    consecutiveEmpty,
    signalFrequency,
    errsigFrequency,
    saturatedSignals,
    recurringErrors,
    suggestedStrategy,
    strategyReason,
    strategyWeights,
    outcomeMix,
    candidatesForPromotion,
  };
}

// --- v2: PersonalityState -------------------------------------------------
//
// Five traits, all floats in [PERSONALITY_MIN, PERSONALITY_MAX]. The daemon
// nudges them by at most ±PERSONALITY_NUDGE per session based on outcome,
// clamped hard. Every change is logged to evolver.log so you can audit
// drift. The rule is intentionally boring:
//
//   many recent crashes        → rigor ↑, creativity ↓, risk_tolerance ↓
//   many recent empties        → creativity ↑, risk_tolerance ↑
//   saturated signals          → rigor ↑     (stabilize)
//   trending pass with churn   → verbosity ↑ (more context helps model)
//   everything otherwise calm  → drift toward defaults (half-life ~20 sessions)
//
// We don't auto-modify prompts or skills. The personality is rendered as a
// single advisory line into the digest, the model decides what to do.

function clampTrait(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(PERSONALITY_MIN, Math.min(PERSONALITY_MAX, n));
}

export function loadPersonality() {
  ensureDirs();
  if (!fs.existsSync(PERSONALITY_FILE)) {
    return { type: 'PersonalityState', ...PERSONALITY_DEFAULTS, updated_at: null };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(PERSONALITY_FILE, 'utf8'));
    const out = { type: 'PersonalityState' };
    for (const t of PERSONALITY_TRAITS) {
      out[t] = clampTrait(raw?.[t] !== undefined ? raw[t] : PERSONALITY_DEFAULTS[t]);
    }
    out.updated_at = typeof raw?.updated_at === 'string' ? raw.updated_at : null;
    return out;
  } catch {
    logLine(`personality: failed to parse ${PERSONALITY_FILE}, resetting to defaults`);
    return { type: 'PersonalityState', ...PERSONALITY_DEFAULTS, updated_at: null };
  }
}

function writePersonality(p) {
  ensureDirs();
  const tmp = PERSONALITY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2), 'utf8');
  fs.renameSync(tmp, PERSONALITY_FILE);
}

/**
 * Propose nudges from the latest analysis. Returns an object mapping
 * trait → delta (in [-PERSONALITY_NUDGE, +PERSONALITY_NUDGE]). Pure function,
 * no side effects.
 */
export function proposePersonalityNudges(analysis) {
  const deltas = { rigor: 0, creativity: 0, verbosity: 0, risk_tolerance: 0, obedience: 0 };
  if (!analysis || analysis.total === 0) return deltas;

  const N = PERSONALITY_NUDGE;
  const om = analysis.outcomeMix || {};
  const recentTotal = analysis.recentWindow || 1;
  const crashRate = (om.crash + om.partial) / recentTotal;
  const emptyRate = om.empty / recentTotal;

  // Crash-heavy window → tighten up.
  if (analysis.consecutiveFailures >= FAILURE_LOOP_THRESHOLD || crashRate >= 0.5) {
    deltas.rigor          += N;
    deltas.creativity     -= N;
    deltas.risk_tolerance -= N;
  }
  // Lots of empty cycles → loosen up and try things.
  else if (analysis.consecutiveEmpty >= EMPTY_LOOP_THRESHOLD || emptyRate >= 0.4) {
    deltas.creativity     += N;
    deltas.risk_tolerance += N;
    deltas.verbosity      -= N / 2;
  }
  // Saturation → stabilize (same as crash but gentler).
  else if ((analysis.saturatedSignals || []).length > 0) {
    deltas.rigor          += N / 2;
    deltas.creativity     -= N / 2;
  }
  // Otherwise: drift back toward defaults. Simple: move halfway to default
  // but capped by N.
  // Implemented by the caller since it needs current state.
  return deltas;
}

/**
 * Compute a drift-toward-defaults correction on top of the analysis-driven
 * nudge. Together these are bounded by PERSONALITY_NUDGE per trait.
 */
function driftToDefaults(current, deltas) {
  const N = PERSONALITY_NUDGE;
  for (const trait of PERSONALITY_TRAITS) {
    // Only drift if we didn't already have an analysis-driven nudge.
    if (Math.abs(deltas[trait]) > 1e-6) continue;
    const diff = PERSONALITY_DEFAULTS[trait] - current[trait];
    if (Math.abs(diff) < 0.01) continue;  // already at default
    // Move halfway to default, capped by N/2 (half-life ~20 sessions).
    const step = Math.sign(diff) * Math.min(Math.abs(diff) / 2, N / 2);
    deltas[trait] = step;
  }
  return deltas;
}

/**
 * Apply nudges to the persisted personality and return the new state.
 * Logs every change. Hard-clamps each trait after application.
 */
export function updatePersonality(analysis) {
  const current = loadPersonality();
  const rawDeltas = proposePersonalityNudges(analysis);
  const deltas = driftToDefaults(current, rawDeltas);

  // Defensive: clip each delta to PERSONALITY_NUDGE.
  for (const t of PERSONALITY_TRAITS) {
    if (Math.abs(deltas[t]) > PERSONALITY_NUDGE) {
      deltas[t] = Math.sign(deltas[t]) * PERSONALITY_NUDGE;
    }
  }

  const next = { type: 'PersonalityState' };
  const changes = [];
  for (const t of PERSONALITY_TRAITS) {
    const before = current[t];
    const after = clampTrait(before + deltas[t]);
    next[t] = after;
    if (Math.abs(after - before) >= 0.005) {
      changes.push(`${t} ${before.toFixed(2)}→${after.toFixed(2)}`);
    }
  }
  next.updated_at = new Date().toISOString();

  writePersonality(next);
  if (changes.length) {
    logLine(`personality: ${changes.join(', ')} (strategy=${analysis.suggestedStrategy})`);
  }
  return { before: current, after: next, deltas, changes };
}

/**
 * Render the personality as one human-readable line for the digest.
 */
export function renderPersonalityLine(p) {
  return PERSONALITY_TRAITS
    .map(t => `${t}=${p[t].toFixed(2)}`)
    .join(' | ');
}

/**
 * Format strategy weights as a compact advisory string.
 */
export function renderStrategyWeights(w) {
  const pct = (x) => (x * 100).toFixed(0) + '%';
  return `repair=${pct(w.repair)} optimize=${pct(w.optimize)} innovate=${pct(w.innovate)} explore=${pct(w.explore)}`;
}

/**
 * Render a digest to Markdown. Keep it short — it goes into the system prompt.
 */
export function renderDigestMarkdown(analysis, opts = {}) {
  const now = new Date().toISOString();
  const emptyState = analysis.total === 0;
  const lines = [];
  lines.push(`# pi-evolver digest`);
  lines.push('');
  lines.push(`_Updated: ${now} — scanned ${analysis.total} total events, analyzed last ${analysis.recentWindow}._`);
  lines.push('');

  if (emptyState) {
    lines.push('No session events recorded yet. Work with Pi for a while; this digest will populate.');
    return lines.join('\n') + '\n';
  }

  lines.push(`## Suggested strategy: **${analysis.suggestedStrategy}**`);
  lines.push('');
  lines.push(`Reason: ${analysis.strategyReason}`);
  if (analysis.strategyWeights) {
    lines.push(`Intent mix: ${renderStrategyWeights(analysis.strategyWeights)}  (repairLoopThreshold=${analysis.strategyWeights.repairLoopThreshold})`);
  }
  lines.push('');

  if (opts.personality) {
    lines.push('## Session personality (advisory, clamped to [0.10, 0.90])');
    lines.push('');
    lines.push(`- ${renderPersonalityLine(opts.personality)}`);
    lines.push('');
  }

  lines.push('## Recent outcomes');
  const om = analysis.outcomeMix;
  lines.push(`- pass: ${om.pass}  crash: ${om.crash}  partial: ${om.partial}  empty: ${om.empty}  unknown: ${om.unknown}`);
  if (analysis.consecutiveFailures > 0) {
    lines.push(`- **Trailing failure streak: ${analysis.consecutiveFailures}**`);
  }
  if (analysis.consecutiveEmpty > 0) {
    lines.push(`- Trailing empty-session streak: ${analysis.consecutiveEmpty}`);
  }
  lines.push('');

  if (analysis.recurringErrors.length) {
    lines.push('## Recurring errors');
    for (const e of analysis.recurringErrors.slice(0, 5)) {
      lines.push(`- \`${e.errsig}\` (seen ${e.count}×)${e.sampleSummary ? ' — ' + String(e.sampleSummary).slice(0, 120) : ''}`);
    }
    lines.push('');
  }

  if (analysis.saturatedSignals.length) {
    lines.push('## Over-represented signals');
    for (const s of analysis.saturatedSignals) {
      lines.push(`- \`${s.signal}\` appeared in ${s.occurrences}/${s.window} recent sessions`);
    }
    lines.push('');
  }

  if (analysis.candidatesForPromotion.length) {
    lines.push('## Candidates for promotion to a skill');
    lines.push('Run `pi-evolver promote <id>` to turn any of these into a permanent skill:');
    for (const c of analysis.candidatesForPromotion.slice(0, 5)) {
      lines.push(`- **${c.id}** — ${c.count} occurrences${c.sampleSummary ? ': ' + String(c.sampleSummary).slice(0, 120) : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Write digest files atomically (write-then-rename pattern).
 * Also updates PersonalityState based on the analysis.
 */
export function writeDigest(analysis) {
  ensureDirs();
  const { after: personality } = updatePersonality(analysis);
  const md = renderDigestMarkdown(analysis, { personality });
  const tmpMd = DIGEST_FILE + '.tmp';
  const tmpJson = DIGEST_JSON + '.tmp';
  fs.writeFileSync(tmpMd, md, 'utf8');
  fs.writeFileSync(tmpJson, JSON.stringify({
    generated_at: new Date().toISOString(),
    personality,
    ...analysis,
  }, null, 2), 'utf8');
  fs.renameSync(tmpMd, DIGEST_FILE);
  fs.renameSync(tmpJson, DIGEST_JSON);
  return md;
}
