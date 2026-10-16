import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..", "..");
const migrationsDir = join(root, "supabase", "migrations");

export async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(readFileSync(join(import.meta.dirname, "supabase-stub.sql"), "utf8"));
  for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    // Supabase-only extensions are provided by supabase-stub.sql
    const sql = readFileSync(join(migrationsDir, f), "utf8").replace(/^create extension if not exists (pg_net|pg_cron)[^;]*;$/gim, "");
    await db.exec(sql);
  }
  // Mirror Supabase defaults: the service role (used by the worker) has full table privileges.
  await db.exec(`grant all on all tables in schema public to service_role;
    grant usage, select on all sequences in schema public to service_role;
    grant usage on schema vault to service_role; grant select on vault.decrypted_secrets to service_role;`);
  return db;
}

export async function createUser(db: PGlite, id: string, email = `${id.slice(0, 8)}@test.local`) {
  await db.query("insert into auth.users(id, email) values ($1, $2)", [id, email]);
}

/** Run `fn` as an authenticated end user (RLS enforced), inside a transaction that is always rolled back unless commit=true. */
export async function asUser<T>(
  db: PGlite,
  userId: string | null,
  fn: (q: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>) => Promise<T>,
  opts: { commit?: boolean } = {},
): Promise<T> {
  await db.exec("begin");
  try {
    await db.exec(`set local role ${userId ? "authenticated" : "anon"}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? ""]);
    const q = async <R,>(sql: string, params: unknown[] = []) => (await db.query<R>(sql, params)).rows;
    const result = await fn(q);
    await db.exec(opts.commit ? "commit" : "rollback");
    return result;
  } catch (e) {
    await db.exec("rollback");
    throw e;
  }
}

export const STAGES = JSON.stringify([
  { key: "new", label: { ar: "جديد", en: "New" } },
  { key: "qualified", label: { ar: "مؤهل", en: "Qualified" }, probability: 20 },
  { key: "won", label: { ar: "ربح", en: "Won" }, kind: "won", probability: 100 },
  { key: "lost", label: { ar: "خسارة", en: "Lost" }, kind: "lost", probability: 0 },
]);
