/**
 * Security tests from the spec: a signed-in member of household A cannot read a row of household B;
 * the audit log is insert-only; a transaction cannot reach sent_to_bc without a BC External Document No.;
 * the idempotency key is unique per household and immutable.
 *
 * Needs DATABASE_URL (migrator/owner connection). Skipped when it is not set.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";

const url = process.env["DATABASE_URL"];
const d = url ? describe : describe.skip;

d("row-level security and invariants", () => {
  let owner: pg.Client;
  let appClient: pg.Client;
  let hhA: string;
  let hhB: string;
  let memberA: string;
  let acctA: string;
  let acctB: string;

  beforeAll(async () => {
    await migrate(url!);
    owner = new pg.Client({ connectionString: url, ssl: false });
    await owner.connect();
    // Create a login role that is a member of homestead_app, so RLS applies (owners bypass it).
    await owner.query("do $$ begin if not exists (select 1 from pg_roles where rolname='homestead_app_test') then create role homestead_app_test login password 'test' in role homestead_app; end if; end $$");
    await owner.query("grant homestead_app to homestead_app_test");
    const a = await owner.query<{ id: string }>("insert into households (name) values ('A') returning id");
    const b = await owner.query<{ id: string }>("insert into households (name) values ('B') returning id");
    hhA = a.rows[0]!.id;
    hhB = b.rows[0]!.id;
    const m = await owner.query<{ id: string }>("insert into members (household_id, entra_object_id, display_name) values ($1, $2, 'Vanessa') returning id", [hhA, `oid-a-${Date.now()}`]);
    memberA = m.rows[0]!.id;
    await owner.query("insert into members (household_id, entra_object_id, display_name) values ($1, $2, 'Other')", [hhB, `oid-b-${Date.now()}`]);
    acctA = (await owner.query<{ id: string }>("insert into accounts (household_id, kind, institution, display_name, bc_bank_account_code) values ($1,'checking','Beehive','Beehive checking','BEEHIVE-CHK') returning id", [hhA])).rows[0]!.id;
    acctB = (await owner.query<{ id: string }>("insert into accounts (household_id, kind, institution, display_name, bc_bank_account_code) values ($1,'checking','Other','Other checking','BEEHIVE-CHK') returning id", [hhB])).rows[0]!.id;
    for (const hh of [hhA, hhB]) {
      await owner.query("insert into categories (id, household_id, name, \"group\", gl_account) values ('groceries', $1, 'Groceries', 'Food', '603101')", [hh]);
    }
    const u = new URL(url!);
    u.username = "homestead_app_test";
    u.password = "test";
    appClient = new pg.Client({ connectionString: u.toString(), ssl: false });
    await appClient.connect();
  });

  afterAll(async () => {
    await appClient?.end();
    await owner?.end();
  });

  async function asHousehold<T>(hh: string, fn: () => Promise<T>): Promise<T> {
    await appClient.query("begin");
    await appClient.query("select set_config('app.household_id', $1, true)", [hh]);
    try {
      const r = await fn();
      await appClient.query("commit");
      return r;
    } catch (e) {
      await appClient.query("rollback");
      throw e;
    }
  }

  it("lets a household see only its own rows", async () => {
    await owner.query("insert into transactions (household_id, account_id, source, source_ref, idempotency_key, posted_date, amount_cents, merchant_raw) values ($1,$2,'plaid','t1','plaid:a:1','2026-10-20',-1250,'Maverik')", [hhA, acctA]);
    await owner.query("insert into transactions (household_id, account_id, source, source_ref, idempotency_key, posted_date, amount_cents, merchant_raw) values ($1,$2,'plaid','t2','plaid:b:1','2026-10-20',-9999,'Secret')", [hhB, acctB]);
    const seenByA = await asHousehold(hhA, async () => (await appClient.query("select merchant_raw from transactions")).rows);
    expect(seenByA.map((r) => r.merchant_raw)).toEqual(["Maverik"]);
    const accounts = await asHousehold(hhA, async () => (await appClient.query("select id from accounts")).rows);
    expect(accounts.map((r) => r.id)).toEqual([acctA]);
    const members = await asHousehold(hhA, async () => (await appClient.query("select display_name from members")).rows);
    expect(members.map((r) => r.display_name)).toEqual(["Vanessa"]);
  });

  it("refuses an insert into another household even when the id is supplied", async () => {
    await expect(
      asHousehold(hhA, () => appClient.query("insert into transactions (household_id, account_id, source, source_ref, idempotency_key, posted_date, amount_cents) values ($1,$2,'manual','m','man:x','2026-10-20',-1)", [hhB, acctB])),
    ).rejects.toThrow(/row-level security/);
  });

  it("sees nothing without a household set", async () => {
    await appClient.query("begin");
    const r = await appClient.query("select count(*)::int as n from transactions");
    await appClient.query("rollback");
    expect(r.rows[0]!.n).toBe(0);
  });

  it("keeps the audit log insert-only for the app role", async () => {
    await asHousehold(hhA, () => appClient.query("insert into audit_log (household_id, actor, action, entity, entity_id) values ($1, $2, 'test', 'transaction', 'x')", [hhA, memberA]));
    await expect(asHousehold(hhA, () => appClient.query("update audit_log set action = 'tampered'"))).rejects.toThrow(/permission denied/);
    await expect(asHousehold(hhA, () => appClient.query("delete from audit_log"))).rejects.toThrow(/permission denied/);
  });

  it("will not let a transaction reach sent_to_bc without a BC External Document No.", async () => {
    await expect(asHousehold(hhA, () => appClient.query("update transactions set state = 'sent_to_bc' where idempotency_key = 'plaid:a:1'"))).rejects.toThrow(/bc_doc_required/);
    await asHousehold(hhA, () => appClient.query("update transactions set state = 'sent_to_bc', bc_external_doc_no = 'HHAPP-PLD-20261020-ABCDEF01' where idempotency_key = 'plaid:a:1'"));
  });

  it("keeps idempotency keys unique and immutable", async () => {
    await expect(
      asHousehold(hhA, () => appClient.query("insert into transactions (household_id, account_id, source, source_ref, idempotency_key, posted_date, amount_cents) values ($1,$2,'plaid','t1b','plaid:a:1','2026-10-21',-1250)", [hhA, acctA])),
    ).rejects.toThrow(/duplicate key/);
    await expect(asHousehold(hhA, () => appClient.query("update transactions set idempotency_key = 'plaid:a:2' where idempotency_key = 'plaid:a:1'"))).rejects.toThrow(/immutable/);
  });

  it("requires the other spouse to decide an approval", async () => {
    await expect(
      asHousehold(hhA, () => appClient.query("insert into approvals (household_id, kind, payload, requested_by, decided_by, decision) values ($1,'budget_move','{}',$2,$2,'approved')", [hhA, memberA])),
    ).rejects.toThrow(/other_spouse_decides/);
  });

  it("refuses an ORIG budget name on a revision", async () => {
    await expect(asHousehold(hhA, () => appClient.query("insert into budget_revisions (household_id, bc_budget_name, revision_no, lines) values ($1,'BUD26-ORIG',1,'[]')", [hhA]))).rejects.toThrow(/no_original_budget/);
  });

  it("finds a member for sign-in without a household set", async () => {
    const r = await appClient.query("select household_id from members_lookup_fn($1, null)", [memberA]);
    expect(r.rows[0]!.household_id).toBe(hhA);
  });
});
