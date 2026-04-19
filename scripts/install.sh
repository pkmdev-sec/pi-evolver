#!/usr/bin/env bash
# pi-evolver installer
#
# What it does:
#   1. Copies source files into ~/.pi/evolver/
#   2. Installs the Pi extension into ~/.pi/agent/extensions/evolver.ts
#   3. (optional) Registers the launchd job for 6-hourly digest regeneration
#   4. (optional) Symlinks the CLI onto the PATH
#
# What it doesn't touch:
#   - Your existing events.jsonl / digest.* / personality.json (if present)
#   - Pi's source code, settings, or any other extension
#
# Safe to re-run: upgrades in place without clobbering user state.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVOLVER_DIR="${HOME}/.pi/evolver"
PI_EXTENSIONS_DIR="${HOME}/.pi/agent/extensions"

# Colours, only when stdout is a terminal.
if [ -t 1 ]; then
  B="$(printf '\033[1m')"; R="$(printf '\033[0m')"
  GREEN="$(printf '\033[32m')"; YELLOW="$(printf '\033[33m')"; BLUE="$(printf '\033[34m')"
else
  B=""; R=""; GREEN=""; YELLOW=""; BLUE=""
fi
log()  { printf '%s[pi-evolver]%s %s\n' "${BLUE}" "${R}" "$*"; }
warn() { printf '%s[pi-evolver]%s %s\n' "${YELLOW}" "${R}" "$*" >&2; }
ok()   { printf '%s[pi-evolver]%s %s\n' "${GREEN}" "${R}" "$*"; }

need() { command -v "$1" >/dev/null || { warn "required command not found: $1"; exit 1; }; }
need node
need mkdir
need cp

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt 18 ]; then
  warn "Node.js ${NODE_MAJOR} detected — pi-evolver requires Node 18 or newer."
  exit 1
fi

log "installing from ${B}${REPO_ROOT}${R}"
log "target: ${B}${EVOLVER_DIR}${R}"

mkdir -p "${EVOLVER_DIR}" "${PI_EXTENSIONS_DIR}"

# Core files
cp "${REPO_ROOT}/src/lib.mjs"       "${EVOLVER_DIR}/lib.mjs"
cp "${REPO_ROOT}/src/daemon.mjs"    "${EVOLVER_DIR}/daemon.mjs"
cp "${REPO_ROOT}/bin/pi-evolver"    "${EVOLVER_DIR}/pi-evolver"
chmod +x "${EVOLVER_DIR}/daemon.mjs" "${EVOLVER_DIR}/pi-evolver"

# The CLI, when installed, lives next to lib.mjs → use the two-file import
# style. Rewrite the one import line so the installed copy is self-contained.
sed -i.bak "s|from '../src/lib.mjs'|from './lib.mjs'|" "${EVOLVER_DIR}/pi-evolver"
rm -f "${EVOLVER_DIR}/pi-evolver.bak"

# Extension
cp "${REPO_ROOT}/extensions/evolver.ts" "${PI_EXTENSIONS_DIR}/evolver.ts"

ok "core files in place"

# README alongside state for discoverability
cp "${REPO_ROOT}/README.md" "${EVOLVER_DIR}/README.md"

# Optional: symlink the CLI onto PATH
PATH_TARGET=""
for d in "${HOME}/.local/bin" /usr/local/bin; do
  if [ -d "$d" ] && [ -w "$d" ]; then
    PATH_TARGET="$d"; break
  fi
done
if [ -n "${PATH_TARGET}" ]; then
  ln -sf "${EVOLVER_DIR}/pi-evolver" "${PATH_TARGET}/pi-evolver"
  ok "linked CLI → ${PATH_TARGET}/pi-evolver"
else
  warn "could not find a writable dir on PATH to symlink into. Add ~/.local/bin or /usr/local/bin, or invoke the CLI as ${EVOLVER_DIR}/pi-evolver"
fi

# Optional: launchd (macOS only)
if [ "$(uname -s)" = "Darwin" ] && [ "${PI_EVOLVER_NO_LAUNCHD:-0}" != "1" ]; then
  log "installing launchd job (set PI_EVOLVER_NO_LAUNCHD=1 to skip)…"
  "${EVOLVER_DIR}/pi-evolver" install-launchd || warn "launchd install failed (non-fatal)"
fi

# Kick the daemon once so a digest exists immediately
"${EVOLVER_DIR}/pi-evolver" run >/dev/null || true

ok "installed. Next steps:"
cat <<EOF

  1. Run ${B}/reload${R} in any running Pi session to activate the extension.
  2. Use Pi normally. Events accumulate in ${EVOLVER_DIR}/events.jsonl.
  3. Check in weekly: ${B}pi-evolver status${R}

  Kill switch:        ${B}pi-evolver disable${R}          (or: export PI_EVOLVER_DISABLED=1)
  Reset personality:  ${B}pi-evolver personality reset${R}
  Uninstall:          ${B}${REPO_ROOT}/scripts/uninstall.sh${R}

EOF
