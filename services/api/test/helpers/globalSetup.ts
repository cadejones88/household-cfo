/**
 * Runs once before the test files: applies the migrations to the database named by DATABASE_URL (the integration
 * tests' database, homestead_e3 for this package). Without DATABASE_URL nothing happens and the integration tests skip.
 */
import { migrate } from "../../src/db/migrate.js";

export default async function setup(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) return;
  await migrate(url);
}
