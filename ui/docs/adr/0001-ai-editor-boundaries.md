# ADR 0001: AI editor boundaries

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

The AI writing prototype must add remote model support and useful writing
patterns without compromising existing notes, exposing credentials, or expanding
the isolated Editor Lab into a different product.

## Decisions

1. Preserve the existing BlockNote document schema and keep this work isolated
   from the production profile and WPF application.
2. Keep OpenRouter credentials server-side. A remote request may send only the
   user-visible, selected context after explicit privacy consent; paid requests
   additionally require explicit per-request cost confirmation.
3. Reimplement applicable editor behavior patterns rather than copying
   proprietary, user-supplied Chrome extension bundles that have no license
   permitting reuse. Do not represent independent implementations as code forks.
4. Exclude external NotebookLM integration and browser automation from this
   prototype.
5. Keep note analysis read-only and provenance-backed: require a structured
   report, explicit unknown owner/date values, and citations resolved only
   against the active request's source-block map. Fall back visibly to raw
   model text if its structure is invalid.

## Consequences

Existing notes remain compatible; remote inference is opt-in and cost-aware;
analysis cannot mutate notes, and invalid model output cannot create a false
source link. The prototype remains a focused editor evaluation rather than an
extension or external-service automation platform.
