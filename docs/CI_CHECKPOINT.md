# Phase 1 CI checkpoint

This file marks the first end-to-end CI verification point for SOL's family-first persistence/onboarding foundation.

The CI gate for this checkpoint runs:

```text
pnpm typecheck
pnpm test
pnpm build
```

The checkpoint covers the Phase 1 code present on `main`: PostgreSQL persistence/migrations, onboarding, member authentication/sessions, household member creation, multi-account source records, visibility tests and the durable event outbox.
