import { migrate } from "@homestead/api";

export default async function setup(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (url) await migrate(url);
}
