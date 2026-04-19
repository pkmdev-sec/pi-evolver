// Integration test for the Pi extension.
//
// Loads extensions/evolver.ts with the same TypeScript loader Pi uses
// (jiti), wires up fake event handlers, simulates a session lifecycle,
// and verifies the extension records one event and returns a plausible
// digest injection.
//
// Requires Pi (@mariozechner/pi-coding-agent) to be installed globally,
// because we borrow its bundled jiti.
//
//   node tests/extension.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const here = path.dirname(new URL(import.meta.url).pathname);
const require = createRequire(import.meta.url);

// Locate the Pi-bundled jiti (tolerates both global + local layouts).
const piRoot = '/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent';
const jitiPath = path.join(piRoot, 'node_modules', '@mariozechner', 'jiti');

if (!fs.existsSync(jitiPath)) {
  console.error(`skip: pi-coding-agent not found at ${piRoot}`);
  console.error('install Pi first or set PI_ROOT env var');
  process.exit(0);
}

const { createJiti } = require(jitiPath);
const j = createJiti(here, { interopDefault: true });

const extensionPath = path.resolve(here, '..', 'extensions', 'evolver.ts');
const mod = j(extensionPath);
const entry = mod.default || mod;

if (typeof entry !== 'function') {
  console.error('extension default export is not a function');
  process.exit(1);
}

// Back up user state (like lib.test.mjs)
const EVOLVER = path.join(os.homedir(), '.pi', 'evolver');
const EVENTS = path.join(EVOLVER, 'events.jsonl');
const BACKUP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-evolver-extbackup-'));
if (fs.existsSync(EVENTS)) fs.copyFileSync(EVENTS, path.join(BACKUP, 'events.jsonl'));
function restore() {
  const b = path.join(BACKUP, 'events.jsonl');
  if (fs.existsSync(b)) fs.copyFileSync(b, EVENTS);
  else if (fs.existsSync(EVENTS)) fs.unlinkSync(EVENTS);
}
process.on('exit', restore);
process.on('SIGINT', () => { restore(); process.exit(130); });

// Wipe events for a clean run
try { fs.unlinkSync(EVENTS); } catch {}

const handlers = {};
const commands = {};
const api = {
  on: (name, fn) => { handlers[name] = fn; },
  registerCommand: (name, spec) => { commands[name] = spec; },
  exec: async () => ({ stdout: '', stderr: '', code: 0 }),
  appendEntry: () => {},
};
entry(api);

let pass = 0, fail = 0;
const failures = [];
function assert(cond, msg) { if (cond) { pass++; process.stdout.write('.'); } else { fail++; failures.push(msg); process.stdout.write('F'); } }

// 1. Extension registers the expected hooks and the /evolver command.
assert(typeof handlers.session_start === 'function',       'session_start hook registered');
assert(typeof handlers.before_agent_start === 'function',  'before_agent_start hook registered');
assert(typeof handlers.tool_execution_start === 'function','tool_execution_start hook registered');
assert(typeof handlers.tool_result === 'function',         'tool_result hook registered');
assert(typeof handlers.session_shutdown === 'function',    'session_shutdown hook registered');
assert(typeof commands.evolver === 'object',                '/evolver command registered');

// 2. A simulated session lifecycle records exactly one event with the
//    expected shape.
const ctx = {
  cwd: '/tmp/pi-evolver-ext-test',
  hasUI: false,
  sessionManager: { getSessionFile: () => '/tmp/pi-evolver-ext-test.jsonl' },
  ui: { notify: () => {} },
};

await handlers.session_start({ reason: 'startup' }, ctx);

// Tool call 1: clean bash
await handlers.tool_execution_start({ toolCallId: 't1', toolName: 'bash' }, ctx);
await handlers.tool_result({
  toolCallId: 't1', toolName: 'bash',
  result: { content: [{ type: 'text', text: 'ok\n' }] },
}, ctx);

// Tool call 2: edit
await handlers.tool_execution_start({ toolCallId: 't2', toolName: 'edit' }, ctx);
await handlers.tool_result({
  toolCallId: 't2', toolName: 'edit',
  result: { content: [{ type: 'text', text: 'Successfully replaced 1 block' }] },
}, ctx);

// Tool call 3: errored bash
await handlers.tool_execution_start({ toolCallId: 't3', toolName: 'bash' }, ctx);
await handlers.tool_result({
  toolCallId: 't3', toolName: 'bash',
  result: { content: [{ type: 'text', text: 'Error: command not found\nCommand exited with code 127' }] },
}, ctx);

// before_agent_start: may or may not return injection depending on whether
// a digest exists. Just verify it doesn't throw.
let injection = null;
try {
  injection = await handlers.before_agent_start({
    prompt: 'hi', systemPrompt: 'You are helpful.',
  }, ctx);
  assert(true, 'before_agent_start did not throw');
} catch (e) {
  assert(false, 'before_agent_start threw: ' + e.message);
}
if (injection && injection.systemPrompt) {
  assert(injection.systemPrompt.startsWith('You are helpful.'), 'injection preserves original prompt');
  assert(injection.systemPrompt.length > 'You are helpful.'.length, 'injection appended something');
}

await handlers.session_shutdown({}, ctx);

assert(fs.existsSync(EVENTS), 'events.jsonl exists after shutdown');
const lines = fs.readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean);
assert(lines.length === 1, `exactly one event written (got ${lines.length})`);

const evt = JSON.parse(lines[0]);
assert(evt.v === 1, 'event schema version 1');
assert(evt.tool_calls === 3, 'tool_calls=3');
assert(evt.tool_errors === 1, 'tool_errors=1');
assert(evt.edits === 1, 'edits=1');
assert(Array.isArray(evt.signals), 'signals is array');
assert(evt.signals.some(s => s.startsWith('errsig:')), 'errsig signal generated for the failed bash');
assert(typeof evt.outcome === 'string', 'outcome present');
assert(evt.cwd === '/tmp/pi-evolver-ext-test', 'cwd captured');

// 3. Extension respects the kill-switch.
try { fs.unlinkSync(EVENTS); } catch {}
process.env.PI_EVOLVER_DISABLED = '1';
// Fresh extension instance with the env var set
const handlers2 = {};
const api2 = { on: (n,f) => { handlers2[n]=f; }, registerCommand: () => {} };
entry(api2);
await handlers2.session_start({ reason: 'startup' }, ctx);
await handlers2.tool_result({ toolCallId:'x', toolName:'bash', result:{content:[{type:'text',text:'ok'}]} }, ctx);
await handlers2.session_shutdown({}, ctx);
assert(!fs.existsSync(EVENTS) || fs.readFileSync(EVENTS,'utf8').trim().length === 0, 'disabled extension wrote nothing');
delete process.env.PI_EVOLVER_DISABLED;

// ── report ──
process.stdout.write('\n');
if (fail === 0) {
  console.log(`✓ all ${pass} assertions passed`);
  process.exit(0);
} else {
  console.error(`\n✗ ${fail} of ${pass + fail} assertions failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
