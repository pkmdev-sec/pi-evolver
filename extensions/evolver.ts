// pi-evolver: auto-learning from Pi sessions.
//
// What this extension does:
//   1. Watches the current session (tool calls, errors).
//   2. On session shutdown, appends a metadata-only event to
//      ~/.pi/evolver/events.jsonl.
//   3. On session start / before each agent turn, injects the current digest
//      (from ~/.pi/evolver/digest.md, written by the daemon) into the system
//      prompt so Pi is aware of recent patterns.
//
// What this extension does NOT do:
//   - Record user prompts or tool-result contents. Metadata only.
//   - Call any network. Pure filesystem I/O.
//   - Modify Pi's config, skills, or source code. It only reads.
//   - Throw. Every handler is wrapped so a bug here never breaks Pi.
//
// Kill switch: set PI_EVOLVER_DISABLED=1 in the environment, or touch
//              ~/.pi/evolver/DISABLED.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

const EVOLVER_DIR = path.join(os.homedir(), ".pi", "evolver");
const EVENTS_FILE = path.join(EVOLVER_DIR, "events.jsonl");
const DIGEST_FILE = path.join(EVOLVER_DIR, "digest.md");
const DIGEST_JSON = path.join(EVOLVER_DIR, "digest.json");
const LOG_FILE = path.join(EVOLVER_DIR, "evolver.log");
const DISABLE_FILE = path.join(EVOLVER_DIR, "DISABLED");

// Long-bash threshold (ms): calls over this get flagged as `long_bash`
const LONG_BASH_MS = 60_000;

type SessionStats = {
  sessionId: string;
  startedAt: number;
  cwd: string;
  sessionFile: string | null;
  toolCallCount: number;
  toolErrorCount: number;
  longBashCount: number;
  editCount: number;
  crashed: boolean;
  errorSignatures: Set<string>;
  lastUserTurnAt: number | null;
  lastAssistantTurnAt: number | null;
};

function ensureDir() {
  try { fs.mkdirSync(EVOLVER_DIR, { recursive: true }); } catch { /* ignore */ }
}

function log(msg: string) {
  try {
    ensureDir();
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* never throw from logger */ }
}

function isDisabled(): boolean {
  if (process.env.PI_EVOLVER_DISABLED === "1") return true;
  try { return fs.existsSync(DISABLE_FILE); } catch { return false; }
}

function newStats(cwd: string, sessionFile: string | null): SessionStats {
  return {
    sessionId: crypto.randomBytes(6).toString("hex"),
    startedAt: Date.now(),
    cwd,
    sessionFile,
    toolCallCount: 0,
    toolErrorCount: 0,
    longBashCount: 0,
    editCount: 0,
    crashed: false,
    errorSignatures: new Set(),
    lastUserTurnAt: null,
    lastAssistantTurnAt: null,
  };
}

/**
 * Hash arbitrary error text into a short stable signature.
 * Normalizes paths and numbers so "failed at /Users/x/foo.ts:42" and
 * "failed at /Users/y/foo.ts:99" collapse to the same bucket.
 */
function errsig(text: string): string {
  const normalized = String(text)
    .replace(/\/[^\s"']+/g, "/PATH")
    .replace(/\b\d+\b/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  return "errsig:" + crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 8);
}

/**
 * Look at a tool result and decide whether it represents an error, and if so
 * what bucket to put it in. Returns null if the result looks clean.
 *
 * Heuristic (intentionally dumb):
 *   - explicit isError flag on the result
 *   - non-zero exit code in bash-style output
 *   - text that begins with /Error:|Exception:|Traceback/
 */
function inspectToolResult(result: unknown): { isError: boolean; text: string } {
  if (!result) return { isError: false, text: "" };
  // Pi's tool-result content has shape { content: Array<{type, text?, isError?}> }
  // but could also be a plain error object. Handle both.
  if (typeof result === "object" && result !== null) {
    const r = result as Record<string, unknown>;
    if (r.isError === true) {
      return { isError: true, text: JSON.stringify(r).slice(0, 800) };
    }
    const content = r.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (b.isError === true && typeof b.text === "string") {
            return { isError: true, text: b.text };
          }
          if (typeof b.text === "string") {
            const t = b.text;
            if (/^(Error:|Exception:|Traceback|fatal:|FAIL |✗)/m.test(t)) {
              return { isError: true, text: t };
            }
            // Pi's bash tool stamps exit codes in stdout/stderr tail
            if (/\bexit code[:\s]+([1-9][0-9]*)\b/.test(t) || /Command exited with code ([1-9][0-9]*)/.test(t)) {
              return { isError: true, text: t };
            }
          }
        }
      }
    }
  }
  return { isError: false, text: "" };
}

function deriveSignals(stats: SessionStats): string[] {
  const sigs = new Set<string>();
  if (stats.toolCallCount === 0) sigs.add("no_tool_calls");
  if (stats.toolCallCount > 0 && stats.toolErrorCount / stats.toolCallCount >= 0.3) {
    sigs.add("tool_error_rate:high");
  }
  if (stats.longBashCount >= 2) sigs.add("long_bash_commands");
  if (stats.editCount >= 10) sigs.add("edit_churn:high");
  else if (stats.editCount >= 3) sigs.add("edit_churn:med");
  if (stats.crashed) sigs.add("crashed");
  for (const sig of stats.errorSignatures) sigs.add(sig);
  const dur = Date.now() - stats.startedAt;
  if (dur >= 30 * 60_000) sigs.add("long_session");
  else if (dur < 30_000) sigs.add("short_session");
  return Array.from(sigs);
}

function deriveOutcome(stats: SessionStats): "pass" | "crash" | "partial" | "empty" {
  if (stats.toolCallCount === 0 && stats.editCount === 0) return "empty";
  if (stats.crashed) return "crash";
  if (stats.toolErrorCount === 0) return "pass";
  // Last action — if the *last* tool call errored we call it partial,
  // otherwise treat it as passed-with-warnings.
  return stats.toolErrorCount > stats.toolCallCount / 2 ? "partial" : "pass";
}

function buildSummary(stats: SessionStats): string {
  const dur = Math.round((Date.now() - stats.startedAt) / 1000);
  return `${stats.toolCallCount} tool calls (${stats.toolErrorCount} errored), ${stats.editCount} edits, ${dur}s in ${path.basename(stats.cwd)}`;
}

function buildEvent(stats: SessionStats) {
  return {
    v: 1,
    timestamp: new Date().toISOString(),
    session_id: stats.sessionId,
    cwd: stats.cwd,
    session_file: stats.sessionFile,
    duration_ms: Date.now() - stats.startedAt,
    tool_calls: stats.toolCallCount,
    tool_errors: stats.toolErrorCount,
    edits: stats.editCount,
    long_bash: stats.longBashCount,
    signals: deriveSignals(stats),
    outcome: deriveOutcome(stats),
    summary: buildSummary(stats),
  };
}

// --- digest injection ---

function readDigestForInjection(): string | null {
  try {
    if (!fs.existsSync(DIGEST_FILE)) return null;
    const md = fs.readFileSync(DIGEST_FILE, "utf8").trim();
    if (!md || md.length < 20) return null;
    // Only inject if the digest thinks there's something worth saying:
    // if the digest.json shows suggestedStrategy === "balanced" with no
    // recurring errors and no saturation, inject nothing.
    if (fs.existsSync(DIGEST_JSON)) {
      try {
        const j = JSON.parse(fs.readFileSync(DIGEST_JSON, "utf8"));
        const hasSignal =
          j.suggestedStrategy !== "balanced" ||
          (j.recurringErrors || []).length > 0 ||
          (j.saturatedSignals || []).length > 0 ||
          (j.candidatesForPromotion || []).length > 0;
        if (!hasSignal) return null;
      } catch { /* fall through — inject raw */ }
    }
    return md;
  } catch {
    return null;
  }
}

// --- extension entry point ---

export default function (pi: ExtensionAPI) {
  // Per-extension-instance state. Pi creates a fresh instance per session,
  // so this lives for the duration of one session.
  let stats: SessionStats | null = null;
  // Track in-flight tool-call start times so we can measure duration in the
  // tool_result handler.
  const toolStartTimes = new Map<string, number>();

  // === session_start: initialize stats, prep the digest for this session ===
  pi.on("session_start", async (event, ctx) => {
    try {
      if (isDisabled()) {
        log(`session_start skipped (disabled)`);
        return;
      }
      ensureDir();
      const cwd = ctx.cwd || process.cwd();
      const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? null;
      stats = newStats(cwd, sessionFile);
      log(`session_start reason=${(event as any)?.reason ?? "unknown"} id=${stats.sessionId} cwd=${cwd}`);
    } catch (err) {
      log(`session_start error: ${(err as Error).message}`);
    }
  });

  // === before_agent_start: inject digest into system prompt for this turn ===
  pi.on("before_agent_start", async (event, _ctx) => {
    try {
      if (isDisabled()) return;
      const digest = readDigestForInjection();
      if (!digest) return;
      const sysp = (event as any).systemPrompt ?? "";
      const suffix =
        `\n\n<!-- pi-evolver: injected from ~/.pi/evolver/digest.md -->\n` +
        `## Recent session patterns (advisory)\n\n` +
        `${digest}\n` +
        `<!-- end pi-evolver -->\n`;
      return { systemPrompt: sysp + suffix };
    } catch (err) {
      log(`before_agent_start error: ${(err as Error).message}`);
      return undefined;
    }
  });

  // === tool_execution_start: remember when each call began ===
  pi.on("tool_execution_start" as any, async (event: any, _ctx) => {
    try {
      if (isDisabled() || !stats) return;
      const id = event?.toolCallId || event?.callId || event?.id;
      if (id) toolStartTimes.set(String(id), Date.now());
    } catch { /* silent */ }
  });

  // === tool_result: count tool calls, track errors, spot recurring signatures ===
  pi.on("tool_result", async (event: any, _ctx) => {
    try {
      if (isDisabled() || !stats) return;
      stats.toolCallCount++;

      const toolName: string = event?.toolName ?? event?.tool?.name ?? "";
      if (toolName === "edit" || toolName === "write") stats.editCount++;

      // Duration for bash calls
      const id = event?.toolCallId || event?.callId || event?.id;
      if (id && toolStartTimes.has(String(id))) {
        const started = toolStartTimes.get(String(id))!;
        toolStartTimes.delete(String(id));
        if (toolName === "bash" && Date.now() - started >= LONG_BASH_MS) {
          stats.longBashCount++;
        }
      }

      // Error detection
      const inspection = inspectToolResult(event?.result);
      if (inspection.isError) {
        stats.toolErrorCount++;
        const sig = errsig(inspection.text);
        stats.errorSignatures.add(sig);
      }
    } catch (err) {
      log(`tool_result error: ${(err as Error).message}`);
    }
  });

  // === session_shutdown: build and append the event ===
  pi.on("session_shutdown", async (_event, _ctx) => {
    try {
      if (isDisabled()) {
        log(`session_shutdown skipped (disabled)`);
        return;
      }
      if (!stats) {
        log(`session_shutdown with no stats — skipping`);
        return;
      }
      const record = buildEvent(stats);
      fs.appendFileSync(EVENTS_FILE, JSON.stringify(record) + "\n", "utf8");
      log(`session_shutdown recorded event id=${stats.sessionId} outcome=${record.outcome} signals=${record.signals.length}`);
      stats = null;
    } catch (err) {
      log(`session_shutdown error: ${(err as Error).message}`);
    }
  });

  // === /evolver command: on-demand status from inside a running session ===
  pi.registerCommand("evolver", {
    description: "Show pi-evolver digest and recent events",
    handler: async (_args, ctx) => {
      try {
        const digest = fs.existsSync(DIGEST_FILE) ? fs.readFileSync(DIGEST_FILE, "utf8") : "(no digest yet)";
        const eventsPath = fs.existsSync(EVENTS_FILE) ? EVENTS_FILE : "(no events recorded yet)";
        const disabled = isDisabled() ? "DISABLED" : "active";
        const msg =
          `pi-evolver status: ${disabled}\n` +
          `events file: ${eventsPath}\n` +
          `digest file: ${DIGEST_FILE}\n\n` +
          `--- digest.md ---\n${digest}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else console.log(msg);
      } catch (err) {
        if (ctx.hasUI) ctx.ui.notify(`/evolver error: ${(err as Error).message}`, "error");
      }
    },
  });
}
