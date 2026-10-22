/**
 * Integration: the household seed and the sign-in link work under forced row-level security, as they must in Azure
 * where the administrator is not a superuser. Run as `homestead_app` (no BYPASSRLS) inside one transaction: the
 * name-derived household id is set before the first read, a second seed finds the same household, and the link
 * updates exactly one member and is audited. The API's lookup function then finds the member by object id.
 */
import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { householdIdFor, seedHousehold } from "../src/db/seed.js";
import { linkMember } from "../src/db/linkMember.js";
import { closePool, describeDb } from "./helpers/db.js";
import { getPool } from "../src/db/index.js";

describeDb("Household setup under row-level security", () => {
  afterAll(async () => {
    await closePool();
  });

  it("derives the household id from its name, stably", () => {
    expect(householdIdFor("Cade & Vanessa Jones Family")).toBe(householdIdFor("Cade & Vanessa Jones Family"));
    expect(householdIdFor("Cade & Vanessa Jones Family")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(householdIdFor("A")).not.toBe(householdIdFor("B"));
  });

  it("seeds, re-seeds and links a sign-in as a role that row-level security binds", async () => {
    const name = `RLS setup ${randomUUID().slice(0, 8)}`;
    const oid = randomUUID();
    const client = await getPool().connect();
    try {
      await client.query("begin");
      await client.query("set local role homestead_app");
      const first = await seedHousehold(client, { name, entraPrefix: `rls-${oid.slice(0, 8)}`, ledger: { tenantId: "t-1", environment: "CADE_Sandbox_vs25", companyId: "c-1", certSecretRef: "bc-sandbox-client-cert" } });
      expect(first.created).toBe(true);
      expect(first.householdId).toBe(householdIdFor(name));
      await client.query("select set_config('app.household_id', '', true)");
      const again = await seedHousehold(client, { name });
      expect(again).toMatchObject({ created: false, householdId: first.householdId });
      await client.query("select set_config('app.household_id', '', true)");
      const linked = await linkMember(client, { householdName: name, memberName: "Vanessa", objectId: oid.toUpperCase(), actor: "admin:test" });
      expect(linked).toMatchObject({ householdId: first.householdId, memberId: first.members.vanessa });
      const found = await client.query<{ id: string }>("select id from members_lookup_fn(null, $1)", [oid]);
      expect(found.rows.map((r) => r.id)).toEqual([first.members.vanessa]);
      const audited = await client.query("select 1 from audit_log where household_id = $1 and action = 'member.signin_linked' and after->>'entraObjectId' = $2", [first.householdId, oid]);
      expect(audited.rowCount).toBe(1);
      const ledger = await client.query<{ bc_company_id: string; api_base_url: string }>("select bc_company_id, api_base_url from ledger_connections where household_id = $1", [first.householdId]);
      expect(ledger.rows[0]).toEqual({ bc_company_id: "c-1", api_base_url: "https://api.businesscentral.dynamics.com/v2.0/t-1/CADE_Sandbox_vs25/api/v2.0" });
      await expect(linkMember(client, { householdName: name, memberName: "Nobody", objectId: oid, actor: "admin:test" })).rejects.toThrow(/No member named "Nobody"/);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
