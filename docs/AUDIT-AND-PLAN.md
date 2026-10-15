# AI Sales Platform Iraq — Phase 0 audit and plan

_15 Oct 2026_

## 1. What already exists

This is a new, standalone project; there was no existing codebase for it.

| Source | Finding |
| --- | --- |
| GitHub | `hassination-source/ai-sales-iraq` — this project's repo. |
| Supabase | Project `ai-sales-iraq` (ref `oyxrldoxuqrjevllvsvr`, Frankfurt eu-central-1) created 16 Oct 2026; both migrations applied; security advisor clean; live isolation smoke test passed. |
| ALTAGA (Sigen business system) | Not in any reachable repo. |

**Decision:** new standalone repo on Supabase (Postgres + Auth + RLS) and Vercel (Next.js).

## 2. Engineering conventions

- pnpm workspaces + Turborepo, TypeScript strict, Vitest
- Zod at every boundary; shared domain package
- AI prompts kept as versioned assets, not inline strings
- "Unknown stays unknown": the AI never fills gaps with guesses

## 3. Architecture and critical decisions

```
apps/web            Next.js (Vercel) — RTL-first UI           [next milestone]
packages/core       Domain: industry packs, scoring, qualification, lead import, geo, i18n
packages/db         Migration + RLS verification on in-process Postgres (PGlite)
supabase/migrations Single source of truth for the schema
```

1. **Tenant isolation is enforced in the database, not only in app code.** Every tenant table has RLS; cross-row links use composite `(tenant_id, id)` foreign keys, so a row can never reference another tenant's data; `tenant_id` is immutable.
2. **Industry = data.** A pack (`packages/core/src/packs/*.ts`) defines segments, company fields, qualification fields, stages (with facts required to enter them), scoring rules, languages, channels and AI guardrails. The core never branches on pack id. Tenants override on top (own stages, extra fields, territories, scoring tweaks); the merged result is re-validated.
3. **Explainable scoring, no AI.** Fit score = deterministic rules with reasons. Unknown data is listed as "to research" and never counts for or against a lead; a coverage figure says how much to trust the score.
4. **Human-in-the-loop by construction.** AI drafts must record grounding sources; only owner/admin/manager can approve; only approved drafts can be sent; approved drafts can't be edited. Enforced by DB triggers.
5. **Metrics come from events.** `activities` (deal created, stage changed, …) and `usage_events` (AI/messaging cost) are append-only streams; dashboards compute from them.
6. **Audit trail** on memberships, config, deals, drafts, contacts and stages — written by triggers, readable by owner/admin, unwritable by users.
7. **Imported data is never "verified".** Verified requires a verification timestamp; web/API leads require a source URL.

## 4. Done in this milestone (Phase 1 foundation)

| Item | Status |
| --- | --- |
| Schema: tenants, members (owner/admin/manager/salesperson), platform admins, industry config, pipelines/stages, companies, contacts, deals, tasks, message drafts, activities, usage events, audit log | Done |
| RLS + role rules + onboarding function `app.create_tenant` | Done, tested |
| Industry-pack engine + Solar pack + Auto-parts pack | Done, tested |
| Lead import: CSV (BOM, quotes, `,`/`;`/tab), Arabic/English header detection, Arabic normalization, Iraqi phone → E.164, 19 governorates, duplicate detection (name+governorate, phone, website; in-file and vs existing) | Done, tested |
| Tests | 46 passing (24 core, 22 database incl. tenant isolation and onboarding RPC) |

Not yet built: web UI, Excel import, AI research/draft generation, knowledge base, WhatsApp/email, campaigns, billing, platform admin UI.

## 5. Next milestones

1. **Vercel + auth** — database is live; next: Supabase Auth (email + phone OTP), deploy web app to Vercel.
2. **Web app shell** — Arabic RTL / English, onboarding (pick industry pack), leads list with filters by governorate, CSV/Excel import screen with duplicate review, pipeline board with stage-requirement checks, tasks.
3. **Knowledge base + grounded AI drafts** — upload brochures/price lists, retrieval, Arabic (Iraqi) and English drafts with sources shown, approve/edit/reject UI, cost metering into `usage_events`.
4. **WhatsApp Business Cloud API** — templates, opt-in/opt-out, webhooks, human takeover.
5. Campaigns, reporting/ROI, subscriptions, platform admin.

## 6. Blockers needing your input

_Resolved:_ GitHub repo `hassination-source/ai-sales-iraq` connected and pushed; Supabase project live. Free-plan limit: Bab Al Agha's Supabase project was paused to make room — upgrade the ai-sales-iraq org to Pro before onboarding paying tenants.

1. **Sigen content for the knowledge base** — approved product catalogue, price list (and whether prices may be quoted by AI), company profile, approved case studies.
2. **WhatsApp Business** — do you have a Meta Business account and a dedicated number for the WhatsApp Cloud API?
3. **Legal** — consent/direct-marketing rules for cold outreach in Iraq (federal and Kurdistan Region) need confirmation by local counsel; the schema records a consent basis per contact so the rule can be enforced once decided.
