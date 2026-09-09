# Optional planning inputs

Deliberate Delegate can consume an external planning skill's output as input to
its own Work Package brief. It never treats that output as authorization,
acceptance, or a replacement for the canonical DD records and gates.

## Local-only integration choice

Before using an upstream planning skill, the Planning Lead describes the local
integration choice and obtains explicit user configuration or approval. Do not
silently override an upstream skill's tracker, triage, issue, or file behavior.
External issue publication and skill installation require separate,
action-specific user authorization. If a skill is not installed or the required
tracker setup is absent, DD proceeds from its own brief without pretending that
the skill was invoked or tested. No automatic extra agents are started.

## `to-spec` as optional specification input

Use [Matt Pocock's `to-spec`](https://github.com/mattpocock/skills/tree/main/skills/engineering/to-spec)
only when a specification or user-story synthesis would materially clarify the
work. Its upstream workflow assumes configured tracker/triage setup and may
produce useful specification content without exact file paths. A path-free spec
is acceptable planning input; the DD dispatch brief must still add the exact
write allowlist, Work Package outcome and boundaries, acceptance-criteria
mapping, runnable verification, and the unchanged canonical safety capsule.

## `to-tickets` as optional slicing input

Use [Matt Pocock's `to-tickets`](https://github.com/mattpocock/skills/tree/main/skills/engineering/to-tickets)
only when vertical slicing into independent work is useful. It is not a
compulsory pipeline or a DD dependency. When used, preserve its local contract:
one local file per ticket under `.scratch/<feature>/issues/<NN>-slug.md` (or use
the separately authorized real-tracker alternative); do not represent one
checklist file as unmodified upstream ticket output. DD may use an internal
checklist instead, without invoking `to-tickets`.

Ticket drafts and tracker statuses are working planning inputs. They cannot
change immutable accepted scope or authorized commitments. If adopted, freeze
the relevant input references and content into versioned DD records and map the
result to one or more bounded Work Packages through the normal planner and user
gates.

## Deferred or incompatible upstream workflows

Do not invoke or install [Matt Pocock's `grill-with-docs`](https://github.com/mattpocock/skills/tree/main/skills/engineering/grill-with-docs)
(grilling/domain-modeling dependencies), [Matt Pocock's `implement`](https://github.com/mattpocock/skills/tree/main/skills/engineering/implement)
(its separate `/code-review` and commit ownership conflict), or [Matt Pocock's `wayfinder`](https://github.com/mattpocock/skills/tree/main/skills/engineering/wayfinder)
(its session, tracker, and research-agent assumptions) as part of DD. Keep
those upstream skills independently installed and maintained if a user chooses
to use them elsewhere; do not vendor or silently modify them here. These source
acknowledgements are not endorsements and do not claim installation or testing.
