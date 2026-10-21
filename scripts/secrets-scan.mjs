// Fails CI when something that looks like a secret is committed. Names of secrets are fine; values are not.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const patterns = [
  [/-----BEGIN (RSA |EC )?PRIVATE KEY-----/, "private key"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b.{0,40}(secret|client_secret)/i, "client secret next to a GUID"],
  [/(client_secret|CLIENT_SECRET|PLAID_SECRET|access_token|ACCESS_TOKEN)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}/, "secret value"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/postgres(ql)?:\/\/[^:\s]+:[^@\s]+@(?!localhost|127\.0\.0\.1)/, "database password in a URL"],
  [/\bSharedAccessKey=[A-Za-z0-9+/=]{20,}/, "Service Bus shared access key"],
  [/\bAccountKey=[A-Za-z0-9+/=]{40,}/, "Storage account key"],
  [/\b\d{3}-\d{2}-\d{4}\b/, "something shaped like an SSN"],
];
const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter((f) => f && !/\.(png|jpg|jpeg|gif|pdf|lock|lockb)$/.test(f) && !f.includes("pnpm-lock"));
let bad = 0;
for (const f of files) {
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  for (const [re, label] of patterns) {
    const m = re.exec(text);
    if (m) { console.error(`${f}: looks like a ${label}: ${m[0].slice(0, 24)}…`); bad += 1; }
  }
}
if (bad) { console.error(`\n${bad} finding(s). Secrets never enter the repo.`); process.exit(1); }
console.log(`Secrets scan: ${files.length} files clean`);
