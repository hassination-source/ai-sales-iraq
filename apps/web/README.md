# Web app

Next.js app for the AI Sales Platform Iraq. Arabic (RTL) by default, English via the language switch.

## Run locally

```bash
cp .env.example .env.local   # fill in the Supabase values
pnpm install                 # from the repo root
pnpm --filter @ais/web dev
```

## Environment variables

| Name | What |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key (safe in the browser; data is protected by row-level security) |
| `NEXT_PUBLIC_SITE_URL` | Public URL of the deployment, used in sign-up confirmation links |

## Deployment

Vercel project `ai-sales-iraq`, root directory `apps/web`. Every push to `main` deploys to production.

In Supabase → Authentication → URL Configuration, the Site URL and Redirect URLs must match the deployed address.
