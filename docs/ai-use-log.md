# Family Thread AI-use log

## Purpose

This log records product-runtime AI behavior so reviewers can verify that Family Thread uses approved text only, preserves source traceability, and never publishes automatically. Do not place secrets, raw private text, family names, media URLs, image data, audio, or provider responses containing private content in this repository.

Developer-tool assistance is not a Family Thread runtime call. Record it here only when it materially changes a product AI policy, prompt contract, evaluation, or provider integration.

## Current status

No Family Thread provider integration is implemented yet. The manual writing path must remain usable before and after AI is introduced.

## Required entry format

Add one entry for each material runtime-AI change:

```markdown
## AI-USE-NNN — Short change title

- Date: YYYY-MM-DD
- Status: proposed | test-only | enabled | disabled
- Owner: role or team
- Provider/model: provider and pinned model identifier, with no credential
- Invocation: Edge Function or server workflow name
- Authorized inputs: approved text source types only
- Explicitly excluded: images, raw audio, unapproved text, secrets, identifiers not required by the task
- Output: draft shape and maximum intended length
- Source linkage: how source IDs are returned and stored
- Human control: edit, approve, discard, and manual fallback behavior
- Logging/retention: redaction and provider retention settings
- Evaluation: source-grounding, privacy, failure, and fallback tests
- Rollback: how to disable the provider without blocking manual completion
```

## Release gate

A Family Thread integration cannot ship until tests prove that the server re-reads currently authorized sources, sends text only, associates the returned draft with source IDs, keeps private text out of normal logs, requires explicit human approval, and allows manual completion during provider failure.
