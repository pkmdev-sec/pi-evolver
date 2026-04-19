# Security policy

## Supported versions

Only the latest minor release on `main` receives security updates.
Older tags are not patched.

## Reporting a vulnerability

Please **do not** open a public GitHub issue.

Email [puneetkmr187@gmail.com](mailto:puneetkmr187@gmail.com) with the
subject line `[pi-evolver security] <short title>`.

Please include:

- affected commit / release
- environment (OS, Node version)
- steps to reproduce or a minimal PoC
- suggested mitigation if you have one

### What to expect

- acknowledgement: within 72 hours
- initial assessment: within 7 days
- fix / advisory: critical issues within 14 days; lower severity follows
  the normal cadence
- credit: I'll credit the reporter in the advisory and CHANGELOG unless
  you prefer anonymity

### Scope

In scope:

- the contents of this repository
- the installer and uninstaller scripts
- the `pi-evolver` CLI
- the bundled Pi extension

Out of scope:

- vulnerabilities in the upstream Pi coding agent (report to the Pi
  repo)
- third-party dependencies (this repo has none at runtime — only `node:*`)
- bugs that require an attacker to already have write access to
  `~/.pi/evolver/` or your Pi extensions directory

## Safe harbor

Good-faith security research conducted under this policy is authorized.
I will not pursue legal action against researchers who:

- give me reasonable time to respond before public disclosure
- avoid accessing data that does not belong to them
- do not degrade the service for other users

Thank you for helping keep this project honest.
