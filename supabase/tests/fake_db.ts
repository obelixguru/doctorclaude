// An in-memory stand-in for the Supabase client, just enough for the edge functions to run for real
// in supabase/tests/pipeline.test.ts. Filters, ordering and upsert behave like PostgREST's; the
// 1000-row cap is applied too, because code has been bitten by it before.

// deno-lint-ignore-file no-explicit-any
type Row = Record<string, any>;

export const world = {
  tables: {} as Record<string, Row[]>,
  rpc: {} as Record<string, (args: any) => any>,
  nextId: 1000,
  /** Tables whose writes fail, to prove a lost write is said out loud. */
  failInsert: new Set<string>(),
  /** Tables whose reads fail, to prove nobody relies on them working. */
  failSelect: new Set<string>(),
};

export function resetWorld() {
  world.tables = {};
  world.rpc = {};
  world.failInsert = new Set();
  world.failSelect = new Set();
}

const isTime = (v: unknown) => typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v);
const norm = (v: any) => (isTime(v) ? Date.parse(v) : v);
const DEFAULTS: Record<string, Row> = {
  mechabetics_readings: { suspect: false, source: null },
};
/** What an upsert with no onConflict lands on: the primary key, as in PostgREST. */
const PRIMARY: Record<string, string> = { mechabetics_monitor_state: "subject" };

class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private sort: { col: string; asc: boolean } | null = null;
  private slice: [number, number] | null = null;
  private one: "single" | "maybe" | null = null;
  private op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private payload: any = null;
  private opts: any = {};
  private wantRows = false;
  constructor(private table: string) {
    world.tables[table] ??= [];
  }
  select(_cols?: string) { if (this.op !== "select") this.wantRows = true; return this; }
  eq(c: string, v: any) { this.filters.push((r) => norm(r[c]) === norm(v)); return this; }
  gte(c: string, v: any) { this.filters.push((r) => norm(r[c]) >= norm(v)); return this; }
  gt(c: string, v: any) { this.filters.push((r) => norm(r[c]) > norm(v)); return this; }
  lte(c: string, v: any) { this.filters.push((r) => norm(r[c]) <= norm(v)); return this; }
  lt(c: string, v: any) { this.filters.push((r) => norm(r[c]) < norm(v)); return this; }
  or(_s: string) { return this; }
  order(col: string, o?: { ascending?: boolean }) { this.sort = { col, asc: o?.ascending !== false }; return this; }
  limit(n: number) { this.slice = [0, n - 1]; return this; }
  range(a: number, b: number) { this.slice = [a, b]; return this; }
  maybeSingle() { this.one = "maybe"; return this; }
  single() { this.one = "single"; return this; }
  insert(p: any) { this.op = "insert"; this.payload = p; return this; }
  upsert(p: any, o?: any) { this.op = "upsert"; this.payload = p; this.opts = o ?? {}; return this; }
  update(p: any) { this.op = "update"; this.payload = p; return this; }
  delete() { this.op = "delete"; return this; }

  private run(): { data: any; error: any } {
    const rows = world.tables[this.table];
    const defaults = DEFAULTS[this.table] ?? {};
    const stamp = (r: Row) => ({ id: world.nextId++, ts: new Date().toISOString(), created_at: new Date().toISOString(), ...defaults, ...r });
    if (this.op === "insert" && world.failInsert.has(this.table)) return { data: null, error: { message: "insert failed" } };
    if (this.op === "insert") {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]).map(stamp);
      rows.push(...list);
      return { data: this.wantRows ? (this.one ? list[0] : list) : null, error: null };
    }
    if (this.op === "upsert") {
      const keys = String(this.opts.onConflict ?? PRIMARY[this.table] ?? "id").split(",");
      for (const r of Array.isArray(this.payload) ? this.payload : [this.payload]) {
        const at = rows.findIndex((x) => keys.every((k) => norm(x[k]) === norm(r[k])));
        if (at < 0) rows.push(stamp(r));
        else if (!this.opts.ignoreDuplicates) rows[at] = { ...rows[at], ...r };
      }
      return { data: null, error: null };
    }
    if (this.op === "select" && world.failSelect.has(this.table)) return { data: null, error: { message: "read failed" } };
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") {
      for (const r of hit) Object.assign(r, this.payload);
      return { data: this.wantRows ? hit : null, error: null };
    }
    if (this.op === "delete") {
      world.tables[this.table] = rows.filter((r) => !hit.includes(r));
      return { data: null, error: null };
    }
    let out = hit.slice();
    if (this.sort) {
      const { col, asc } = this.sort;
      out.sort((a, b) => (norm(a[col]) < norm(b[col]) ? -1 : norm(a[col]) > norm(b[col]) ? 1 : 0) * (asc ? 1 : -1));
    }
    if (this.slice) out = out.slice(this.slice[0], this.slice[1] + 1);
    out = out.slice(0, 1000); // max_rows
    if (this.one) return { data: out[0] ?? null, error: null };
    return { data: out, error: null };
  }
  then(ok: (v: any) => any, no?: (e: any) => any) {
    return Promise.resolve().then(() => this.run()).then(ok, no);
  }
}

export function createClient(_url?: string, _key?: string, _o?: unknown) {
  return {
    from: (t: string) => new Query(t),
    rpc: (name: string, args: any) => Promise.resolve({ data: world.rpc[name]?.(args) ?? null, error: null }),
  };
}
