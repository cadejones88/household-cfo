/**
 * Links a person's Entra External ID sign-in to their member record (runbook step 9b). Until a member row carries
 * the person's object id the API answers "not signed in", which is how anyone else who signs up through the user
 * flow is kept out. Runs as a Postgres administrator; works under the forced row-level security that applies to a
 * non-superuser administrator in Azure (the household is found by its name-derived id).
 *
 * Usage: DATABASE_URL=... pnpm --filter @homestead/api db:link-member -- --member Cade --object-id <guid>
 *        [--household "Cade & Vanessa Jones Family"]
 * The object id is the person's Object ID in the family tenant (Entra ID -> Users); it is an identifier, not a secret.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { audit, type Queryable } from "./index.js";
import { useHouseholdByName } from "./seed.js";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LinkResult {
  householdId: string;
  memberId: string;
  previousObjectId: string;
}

export async function linkMember(db: Queryable, input: { householdName: string; memberName: string; objectId: string; actor: string }): Promise<LinkResult> {
  if (!GUID.test(input.objectId)) throw new Error(`"${input.objectId}" is not an object id (expected a GUID)`);
  const hh = await useHouseholdByName(db, input.householdName);
  if (!hh) throw new Error(`No household named "${input.householdName}". Seed it first (pnpm --filter @homestead/api db:seed).`);
  const m = await db.query<{ id: string; entra_object_id: string }>("select id, entra_object_id from members where household_id = $1 and display_name = $2", [hh, input.memberName]);
  const row = m.rows[0];
  if (!row) throw new Error(`No member named "${input.memberName}" in "${input.householdName}"`);
  if (m.rows.length > 1) throw new Error(`More than one member named "${input.memberName}"; link by member id instead`);
  const objectId = input.objectId.toLowerCase();
  await db.query("update members set entra_object_id = $1 where id = $2 and household_id = $3", [objectId, row.id, hh]);
  await audit(db, hh, { actor: input.actor, action: "member.signin_linked", entity: "member", entityId: row.id, before: { entraObjectId: row.entra_object_id }, after: { entraObjectId: objectId } });
  return { householdId: hh, memberId: row.id, previousObjectId: row.entra_object_id };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env["DATABASE_URL"];
  const memberName = arg("member");
  const objectId = arg("object-id");
  const householdName = arg("household") ?? "Cade & Vanessa Jones Family";
  if (!url || !memberName || !objectId) {
    console.error('Usage: DATABASE_URL=... pnpm --filter @homestead/api db:link-member -- --member <Cade|Vanessa> --object-id <guid> [--household "<name>"]');
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: url, ssl: process.env["PGSSLMODE"] === "disable" ? false : { rejectUnauthorized: true } });
  await client.connect();
  try {
    await client.query("begin");
    const r = await linkMember(client, { householdName, memberName, objectId, actor: `admin:${process.env["USER"] ?? "cli"}` });
    await client.query("commit");
    console.log(`Linked ${memberName} (member ${r.memberId}) in household ${r.householdId} to object id ${objectId.toLowerCase()} (was ${r.previousObjectId}).`);
  } catch (e) {
    await client.query("rollback");
    console.error((e as Error).message);
    process.exit(1);
  } finally {
    await client.end();
  }
}
