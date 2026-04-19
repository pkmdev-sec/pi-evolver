# Contributing to pi-evolver

Thanks for the interest. Before you send a PR, read the short list below
and make sure your change fits. pi-evolver is intentionally small and
intentionally bounded.

## The design contract

This tool is **auto-learning, manual promotion**. It:

- observes sessions
- writes advisory notes
- suggests changes
- asks a human to apply them

It does **not**:

- auto-modify any code
- auto-modify its own prompts
- auto-create, auto-edit, or auto-delete skills
- call any network
- record user prompts or tool-output contents

PRs that cross those lines will be politely declined. Everything else is
fair game.

## Good first contributions

- **Linux scheduler support.** The daemon is Node-only and portable; we
  just need a systemd-timer example or a generic daemon wrapper.
- **Claude Code adapter.** The Pi extension is ~250 lines and the only
  platform-specific file. Porting to `@anthropic-ai/claude-code` would
  be similar.
- **A better `errsig` normalizer.** Today we normalize paths and numbers
  into `/PATH` and `N` respectively; there's room for smarter grouping.
- **Ideas-considered updates.** If you look at another self-improvement
  project and decide one of its ideas would fit here, write it up in
  `docs/ideas-considered.md` with the scoring rubric we use there.

## Local setup

```bash
git clone https://github.com/pkmdev-sec/pi-evolver.git
cd pi-evolver
./scripts/install.sh
node tests/lib.test.mjs       # unit tests
node tests/extension.test.mjs # integration tests against the installed Pi
```

There are zero runtime dependencies. The tests use only `node:*` modules.

## Before sending a PR

1. `node --check` every file you touched
2. `node tests/lib.test.mjs && node tests/extension.test.mjs` — both pass
3. If you changed the digest format, update the README table
4. If you added a signal, document it in the README "What it records"
   section
5. If you touched `lib.mjs` or `evolver.ts`, add or update a test

## Commit style

Short imperative subject (≤72 chars), blank line, longer body if needed.
Conventional-commit prefixes are welcome but not required.
