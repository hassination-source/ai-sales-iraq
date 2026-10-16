/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * In-memory stand-in for the parts of the Supabase query builder the worker uses.
 * Enough to exercise mission logic end to end without a network or database.
 */
type Row = Record<string, any>;
let seq = 0;

export class FakeDb {
  tables: Record<string, Row[]> = {};
  uniques: Record<string, string[][]> = {
    companies: [["tenant_id", "source_ref"]],
    company_research: [["tenant_id", "company_id"]],
  };

  from(table: string) {
    this.tables[table] ??= [];
    return new Query(this, table);
  }
  rpc() {
    return Promise.resolve({ data: null, error: null });
  }
  rows(table: string) {
    return this.tables[table] ?? [];
  }
}

class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private op: "select" | "insert" | "update" | "upsert" = "select";
  private payload: any;
  private onConflict: string[] | null = null;
  private orderBy: { col: string; asc: boolean } | null = null;
  private max: number | null = null;
  private mode: "many" | "single" | "maybe" = "many";
  private head = false;
  private wantCount = false;
  private returning = false;

  constructor(private db: FakeDb, private table: string) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") this.op = "select";
    else this.returning = true;
    if (opts?.count) this.wantCount = true;
    if (opts?.head) this.head = true;
    return this;
  }
  insert(p: any) { this.op = "insert"; this.payload = p; return this; }
  update(p: any) { this.op = "update"; this.payload = p; return this; }
  upsert(p: any, o?: { onConflict?: string }) { this.op = "upsert"; this.payload = p; this.onConflict = o?.onConflict?.split(",") ?? null; return this; }
  eq(c: string, v: any) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: any) { this.filters.push((r) => r[c] !== v); return this; }
  in(c: string, v: any[]) { this.filters.push((r) => v.includes(r[c])); return this; }
  is(c: string, v: null) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  not(c: string, _op: "is", v: null) { this.filters.push((r) => (r[c] ?? null) !== v); return this; }
  gte(c: string, v: any) { this.filters.push((r) => r[c] >= v); return this; }
  order(c: string, o?: { ascending?: boolean }) { this.orderBy = { col: c, asc: o?.ascending !== false }; return this; }
  limit(n: number) { this.max = n; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }

  // thenable, like the real query builder
  then(ok?: (v: any) => any, bad?: (e: any) => any) {
    return Promise.resolve(this.run()).then(ok, bad);
  }

  private unique(row: Row): boolean {
    for (const cols of this.db.uniques[this.table] ?? [])
      if (cols.every((c) => row[c] != null) && this.db.rows(this.table).some((r) => cols.every((c) => r[c] === row[c]))) return false;
    return true;
  }

  private run() {
    const rows = this.db.tables[this.table]!;
    const match = () => rows.filter((r) => this.filters.every((f) => f(r)));
    let out: Row[] = [];
    if (this.op === "insert") {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      const fresh = list.map((p: Row) => ({ id: p.id ?? `${this.table}-${++seq}`, created_at: new Date().toISOString(), ...p }));
      for (const r of fresh) if (!this.unique(r)) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
      rows.push(...fresh);
      out = fresh;
    } else if (this.op === "upsert") {
      const p = { ...this.payload };
      const existing = this.onConflict ? rows.find((r) => this.onConflict!.every((c) => r[c] === p[c])) : undefined;
      if (existing) Object.assign(existing, p);
      else rows.push({ id: `${this.table}-${++seq}`, ...p });
      out = [existing ?? rows.at(-1)!];
    } else if (this.op === "update") {
      out = match();
      for (const r of out) Object.assign(r, this.payload);
    } else {
      out = match();
      if (this.orderBy) {
        const { col, asc } = this.orderBy;
        out = [...out].sort((a, b) => ((a[col] ?? -Infinity) > (b[col] ?? -Infinity) ? 1 : -1) * (asc ? 1 : -1));
      }
      if (this.max !== null) out = out.slice(0, this.max);
    }
    const count = this.wantCount ? out.length : undefined;
    if (this.head) return { data: null, error: null, count };
    if (this.mode === "single") return out[0] ? { data: out[0], error: null } : { data: null, error: { message: "no rows" } };
    if (this.mode === "maybe") return { data: out[0] ?? null, error: null };
    return { data: this.op === "select" || this.returning ? out : null, error: null, count };
  }
}
