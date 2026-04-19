#!/usr/bin/env node
// pi-evolver daemon: reads events.jsonl, writes digest.md + digest.json.
// Intended to be run by launchd (see com.pi.evolver.plist) or ad-hoc.
//
// This is a one-shot: compute → write → exit. No long-running process.

import {
  isDisabled,
  logLine,
  rotateEventsIfNeeded,
  readRecentEvents,
  analyzeEvents,
  writeDigest,
  ensureDirs,
} from './lib.mjs';

async function main() {
  ensureDirs();
  if (isDisabled()) {
    logLine('daemon: disabled, exiting');
    return 0;
  }
  const t0 = Date.now();
  rotateEventsIfNeeded();
  const events = readRecentEvents();
  const analysis = analyzeEvents(events);
  writeDigest(analysis);
  logLine(`daemon: analyzed ${events.length} events in ${Date.now() - t0}ms; strategy=${analysis.suggestedStrategy}, candidates=${analysis.candidatesForPromotion.length}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    logLine(`daemon: fatal: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  },
);
