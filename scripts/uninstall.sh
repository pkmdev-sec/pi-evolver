#!/usr/bin/env bash
# pi-evolver uninstaller.
#
# What it removes:
#   - launchd job (if installed)
#   - the Pi extension (~/.pi/agent/extensions/evolver.ts)
#   - the CLI symlinks
#
# What it keeps by default (your history):
#   - ~/.pi/evolver/events.jsonl
#   - ~/.pi/evolver/digest.md, digest.json
#   - ~/.pi/evolver/personality.json
#   - ~/.pi/evolver/evolver.log
#
# Pass --all to remove state too.

set -euo pipefail

EVOLVER_DIR="${HOME}/.pi/evolver"
PI_EXTENSIONS_DIR="${HOME}/.pi/agent/extensions"

if [ -t 1 ]; then
  R="$(printf '\033[0m')"; YELLOW="$(printf '\033[33m')"; BLUE="$(printf '\033[34m')"
else R=""; YELLOW=""; BLUE=""; fi
log()  { printf '%s[pi-evolver]%s %s\n' "${BLUE}" "${R}" "$*"; }
warn() { printf '%s[pi-evolver]%s %s\n' "${YELLOW}" "${R}" "$*" >&2; }

REMOVE_STATE=0
for arg in "$@"; do
  case "$arg" in
    --all) REMOVE_STATE=1 ;;
    -h|--help)
      echo "usage: uninstall.sh [--all]"
      echo "  --all  also delete events.jsonl, digest.*, personality.json (your history)"
      exit 0
      ;;
  esac
done

# 1. launchd
if [ -x "${EVOLVER_DIR}/pi-evolver" ]; then
  "${EVOLVER_DIR}/pi-evolver" uninstall-launchd || true
fi

# 2. extension
rm -f "${PI_EXTENSIONS_DIR}/evolver.ts"
log "removed ${PI_EXTENSIONS_DIR}/evolver.ts"

# 3. CLI symlinks
for d in "${HOME}/.local/bin" /usr/local/bin; do
  if [ -L "$d/pi-evolver" ]; then
    rm -f "$d/pi-evolver"
    log "removed symlink $d/pi-evolver"
  fi
done

# 4. core files (state kept unless --all)
rm -f "${EVOLVER_DIR}/lib.mjs" "${EVOLVER_DIR}/daemon.mjs" "${EVOLVER_DIR}/pi-evolver" "${EVOLVER_DIR}/README.md"
log "removed core files in ${EVOLVER_DIR}"

if [ "${REMOVE_STATE}" -eq 1 ]; then
  rm -rf "${EVOLVER_DIR}"
  warn "also removed ${EVOLVER_DIR} (all state deleted)"
else
  warn "kept history: ${EVOLVER_DIR}/{events.jsonl,digest.*,personality.json,evolver.log}"
  warn "pass --all to remove these too"
fi

log "done. /reload in any running Pi session to drop the extension hooks."
