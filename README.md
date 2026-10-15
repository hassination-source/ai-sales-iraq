# AI Sales Platform Iraq

Multi-tenant AI sales platform for Iraqi businesses. Industries are configured as **industry packs**; Sigen Solar Energy (solar PV / BESS) is the first proof of concept, Auto Parts the second.

## Layout

| Path | What |
| --- | --- |
| `supabase/migrations/` | Postgres schema, row-level security, triggers, onboarding function |
| `packages/core/` | Industry packs, scoring, qualification, lead import, Iraq geography, i18n |
| `packages/db/` | Runs the migrations on in-process Postgres and tests tenant isolation |
| `docs/AUDIT-AND-PLAN.md` | Architecture decisions, progress, next milestones, open questions |

## Commands

```bash
pnpm install
pnpm -r test                               # all tests
pnpm --filter @ais/core exec tsc --noEmit  # type check
```

## Adding an industry

1. Create `packages/core/src/packs/<id>.ts` with `definePack({...})`.
2. Register it in `packages/core/src/packs/index.ts`.
3. Run the tests — invalid packs (unknown fields, missing won/lost stage, duplicate keys) fail validation.

No database or core changes are needed.
