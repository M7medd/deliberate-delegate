# Third-Party Notices

Deliberate Delegate interacts with and depends on third-party software. This document records upstream provenance, license terms, and dependency relationships.

---

## Upstream Dependency: delegate-skills

- **Project Name:** `delegate-skills`
- **Repository:** https://github.com/amElnagdy/delegate-skills
- **Author & Copyright Holder:** Ahmed Mohammed (amElnagdy)
- **License:** MIT License
- **Verification Date:** 2026-09-01
- **Installed Skills Tested:** Verified locally against installed `claude-delegate` (0.5.0), `codex-delegate` (0.5.0), and `agy-delegate` (0.5.0)
- **Upstream executable/source code copied:** `no`

### Role and Dependency Direction

`delegate-skills` provides the underlying implementer layer for Deliberate Delegate:
- Command-line interface (CLI) adapters for external AI agents (`claude-delegate`, `codex-delegate`, `agy-delegate`).
- Exact session resumption mechanisms across consecutive dispatches.
- The `delegate-relay.result.v1` structured execution result contract.

This is a strict one-way dependency: Deliberate Delegate relies upon the presence and CLI interfaces of `delegate-skills`. `delegate-skills` operates independently and does not depend upon Deliberate Delegate.

### License Reproduction

The upstream MIT license text for `delegate-skills` is reproduced in full for attribution and redistribution compliance at:
[`third-party/delegate-skills-LICENSE.txt`](third-party/delegate-skills-LICENSE.txt)

### Non-Endorsement

Deliberate Delegate is an independent project. It is not affiliated with, sponsored by, or endorsed by Ahmed Mohammed (amElnagdy) or the `delegate-skills` project.
