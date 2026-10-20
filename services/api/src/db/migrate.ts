/**
 * Minimal forward-only migrator. Each file in db/migrations runs once, in name order, inside a transaction,
 * and is recorded in `schema_migrations`. Run with the migrator connection (owner), not the app role.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

export async function migrate(connectionString: string, dir?: string): Promise<string[]> {
  const migrationsDir = dir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../db/migrations");
  const client = new pg.Client({ connectionString, ssl: process.env["PGSSLMODE"] === "disable" ? false : { rejectUnauthorized: true } });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    const done = new Set((await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(path.join(migrationsDir, f), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [f]);
        await client.query("commit");
        applied.push(f);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Migration ${f} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set");
  migrate(url)
    .then((a) => {
      console.log(a.length ? `Applied: ${a.join(", ")}` : "Nothing to apply");
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
