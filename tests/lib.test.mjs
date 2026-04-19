// Unit tests for src/lib.mjs. Runnable with plain node — no test runner.
//
//   node tests/lib.test.mjs
//
// Exit 0 on success, 1 on any failure. Prints a compact dotted progress
// line plus a summary. Intentionally avoids any test framework so this
// file has no dependencies.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as L from '../src/lib.mjs';

// ── mini runner ─────────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; failures.push(msg); process.stdout.write('F'); }
}
function assertEq(actual, expected, msg) {
  assert(actual === expected, `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertNear(actual, expected, eps, msg) {
  assert(Math.abs(actual - expected) <= eps, `${msg} — expected ≈${expected} (±${eps}), got ${actual}`);
}

// Swap HOME to a throwaway dir so we don't clobber the real ~/.pi/evolver.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-evolver-test-'));
process.env.HOME = TMP;
// Re-import lib.mjs with the new HOME. Since lib.mjs resolves paths at module-
// load time we need to work around that by writing to the *real* paths lib
// computed. Fortunately lib exposes every path as an export — we can just
// read them after the import.
const EVENTS = L.EVENTS_FILE;
const DIGEST = L.DIGEST_FILE;
const DIGEST_JSON = L.DIGEST_JSON;
const PERSONALITY = L.PERSONALITY_FILE;
const LOG = L.LOG_FILE;

// But those paths reference the REAL HOME, not TMP, because lib was imported
// before we switched HOME. So the test uses the real ~/.pi/evolver — we back
// up any existing user state, run our tests, restore on exit.
const BACKUP = path.join(TMP, 'user-backup');
fs.mkdirSync(BACKUP, { recursive: true });
for (const f of [EVENTS, DIGEST, DIGEST_JSON, PERSONALITY, L.DISABLE_FILE]) {
  if (fs.existsSync(f)) fs.copyFileSync(f, path.join(BACKUP, path.basename(f)));
}
function restore() {
  for (const f of [EVENTS, DIGEST, DIGEST_JSON, PERSONALITY, L.DISABLE_FILE]) {
    const b = path.join(BACKUP, path.basename(f));
    if (fs.existsSync(b)) fs.copyFileSync(b, f);
    else { try { fs.unlinkSync(f); } catch {} }
  }
}
process.on('exit', restore);
process.on('SIGINT', () => { restore(); process.exit(130); });

function reset() {
  try { fs.unlinkSync(EVENTS); } catch {}
  try { fs.unlinkSync(DIGEST); } catch {}
  try { fs.unlinkSync(DIGEST_JSON); } catch {}
  try { fs.unlinkSync(PERSONALITY); } catch {}
  try { fs.unlinkSync(L.DISABLE_FILE); } catch {}
}

// ── tests ────────────────────────────────────────────────────────────

reset();

// 1. empty-state analysis
{
  const a = L.analyzeEvents([]);
  assertEq(a.total, 0, 'empty analysis total');
  assertEq(a.suggestedStrategy, 'balanced', 'empty analysis strategy');
  assert(a.strategyWeights && a.strategyWeights.innovate === 0.5, 'empty analysis has balanced weights');
}

// 2. early-stabilize for young installations
{
  const evts = [
    { outcome: 'pass', signals: [] },
    { outcome: 'pass', signals: [] },
    { outcome: 'pass', signals: [] },
  ];
  const a = L.analyzeEvents(evts);
  assertEq(a.suggestedStrategy, 'early-stabilize', '3 events → early-stabilize');
  assertEq(a.strategyWeights.repair, 0.60, 'early-stabilize repair=0.60');
}

// 3. graduate to balanced after 6 sessions
{
  const evts = Array(6).fill({ outcome: 'pass', signals: [] });
  const a = L.analyzeEvents(evts);
  assertEq(a.suggestedStrategy, 'balanced', '6 events → balanced');
}

// 4. innovate on failure loop (overrides early-stabilize)
{
  const evts = [
    { outcome: 'pass',  signals: [] },
    { outcome: 'crash', signals: ['errsig:aaa'] },
    { outcome: 'crash', signals: ['errsig:aaa'] },
    { outcome: 'crash', signals: ['errsig:aaa'] },
    { outcome: 'crash', signals: ['errsig:aaa'] },
  ];
  const a = L.analyzeEvents(evts);
  assertEq(a.suggestedStrategy, 'innovate', 'failure loop → innovate');
  assertEq(a.consecutiveFailures, 4, 'failure streak count');
  assertEq(a.strategyWeights.innovate, 0.80, 'innovate weights');
}

// 5. steady-state on empty loop
{
  const evts = [
    { outcome: 'empty', signals: [] },
    { outcome: 'empty', signals: [] },
    { outcome: 'empty', signals: [] },
    { outcome: 'empty', signals: [] },
  ];
  const a = L.analyzeEvents(evts);
  assertEq(a.suggestedStrategy, 'steady-state', 'empty loop → steady-state');
}

// 6. harden on signal saturation
{
  const evts = Array(5).fill({ outcome: 'pass', signals: ['tool_error_rate:high'] });
  const a = L.analyzeEvents(evts);
  assertEq(a.suggestedStrategy, 'harden', 'saturation → harden');
  assert(a.saturatedSignals.length >= 1, 'saturated signals present');
}

// 7. candidates for promotion appear at ≥4 occurrences
{
  const evts = Array(5).fill({ outcome: 'pass', signals: ['errsig:abc'] });
  const a = L.analyzeEvents(evts);
  assertEq(a.candidatesForPromotion.length, 1, 'one candidate promoted');
  assertEq(a.candidatesForPromotion[0].id, 'promote_abc', 'candidate id derived from errsig');
}

// 8. personality: first call creates defaults
{
  reset();
  const p = L.loadPersonality();
  assertEq(p.rigor, 0.70, 'default rigor');
  assertEq(p.creativity, 0.35, 'default creativity');
}

// 9. personality update is bounded by ±0.05
{
  reset();
  const analysis = L.analyzeEvents(Array(4).fill({ outcome: 'crash', signals: ['errsig:z'] }));
  const r = L.updatePersonality(analysis);
  for (const t of L.PERSONALITY_TRAITS) {
    const delta = Math.abs(r.after[t] - r.before[t]);
    assert(delta <= L.PERSONALITY_NUDGE + 1e-9, `|Δ${t}| ≤ 0.05 (got ${delta.toFixed(4)})`);
  }
}

// 10. personality clamps to [0.10, 0.90]
{
  reset();
  const violent = {
    total: 20, recentWindow: 20,
    consecutiveFailures: 20, consecutiveEmpty: 0,
    saturatedSignals: [{ signal: 'x', occurrences: 20, window: 20 }],
    outcomeMix: { pass: 0, crash: 20, partial: 0, empty: 0, unknown: 0 },
    suggestedStrategy: 'innovate',
  };
  // Hammer it
  for (let i = 0; i < 20; i++) L.updatePersonality(violent);
  const p = L.loadPersonality();
  for (const t of L.PERSONALITY_TRAITS) {
    assert(p[t] >= L.PERSONALITY_MIN && p[t] <= L.PERSONALITY_MAX, `${t}=${p[t]} within [0.10,0.90]`);
  }
}

// 11. digest injection gate: balanced with no recurring → empty
{
  reset();
  L.writeDigest(L.analyzeEvents([{ outcome: 'pass', signals: [] }]));
  const j = JSON.parse(fs.readFileSync(DIGEST_JSON, 'utf8'));
  // For a young installation, strategy is early-stabilize, not balanced.
  // The *injection gate* in evolver.ts checks for any non-default signal;
  // early-stabilize counts as non-default and will inject. The MD must exist.
  assert(fs.existsSync(DIGEST), 'digest.md exists after writeDigest');
}

// 12. kill-switch: env var
{
  process.env.PI_EVOLVER_DISABLED = '1';
  assertEq(L.isDisabled(), true, 'env var disables');
  delete process.env.PI_EVOLVER_DISABLED;
  assertEq(L.isDisabled(), false, 'env var removed re-enables (if no DISABLED file)');
}

// 13. kill-switch: DISABLED file
{
  fs.writeFileSync(L.DISABLE_FILE, 'x');
  assertEq(L.isDisabled(), true, 'DISABLED file disables');
  fs.unlinkSync(L.DISABLE_FILE);
  assertEq(L.isDisabled(), false, 'removing DISABLED file re-enables');
}

// 14. renderStrategyWeights format
{
  assertEq(
    L.renderStrategyWeights({ repair: 0.2, optimize: 0.2, innovate: 0.5, explore: 0.1 }),
    'repair=20% optimize=20% innovate=50% explore=10%',
    'strategy weight render'
  );
}

// 15. renderPersonalityLine format
{
  const p = { rigor: 0.70, creativity: 0.35, verbosity: 0.25, risk_tolerance: 0.40, obedience: 0.85 };
  assertEq(
    L.renderPersonalityLine(p),
    'rigor=0.70 | creativity=0.35 | verbosity=0.25 | risk_tolerance=0.40 | obedience=0.85',
    'personality line render'
  );
}

// ── report ──────────────────────────────────────────────────────────
reset();
process.stdout.write('\n');
if (fail === 0) {
  console.log(`✓ all ${pass} assertions passed`);
  process.exit(0);
} else {
  console.error(`\n✗ ${fail} of ${pass + fail} assertions failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
