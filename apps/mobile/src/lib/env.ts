/**
 * Build-time configuration. Expo inlines `process.env.EXPO_PUBLIC_*` at bundle time; nothing here is a secret
 * (client ids, hostnames, modes). Secrets never live on the phone.
 */
import { z } from "zod";

const Env = z.object({
  apiUrl: z.string().default("http://localhost:8080"),
  apiMode: z.enum(["http", "mock"]).default("mock"),
  authMode: z.enum(["dev", "entra"]).default("dev"),
  devMembers: z.string().default(""),
  entraTenantName: z.string().default(""),
  entraTenantId: z.string().default(""),
  entraCustomDomain: z.string().default(""),
  entraClientId: z.string().default(""),
  entraApiScope: z.string().default(""),
  easProjectId: z.string().default(""),
});

export type Env = z.infer<typeof Env>;

function read(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

export const env: Env = Env.parse({
  apiUrl: read("EXPO_PUBLIC_API_URL"),
  apiMode: read("EXPO_PUBLIC_API_MODE"),
  authMode: read("EXPO_PUBLIC_AUTH_MODE"),
  devMembers: read("EXPO_PUBLIC_DEV_MEMBERS"),
  entraTenantName: read("EXPO_PUBLIC_ENTRA_TENANT_NAME"),
  entraTenantId: read("EXPO_PUBLIC_ENTRA_TENANT_ID"),
  entraCustomDomain: read("EXPO_PUBLIC_ENTRA_CUSTOM_DOMAIN"),
  entraClientId: read("EXPO_PUBLIC_ENTRA_CLIENT_ID"),
  entraApiScope: read("EXPO_PUBLIC_ENTRA_API_SCOPE"),
  easProjectId: read("EXPO_PUBLIC_EAS_PROJECT_ID"),
});

/** Dev-mode members: "Vanessa:<uuid>,Cade:<uuid>". Without ids the names alone are used (mock mode). */
export function devMembers(): { name: string; id: string }[] {
  const list = env.devMembers
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [name, id] = pair.split(":");
      return { name: (name ?? "").trim(), id: (id ?? "").trim() || `dev-${(name ?? "").trim().toLowerCase()}` };
    })
    .filter((m) => m.name);
  return list.length > 0 ? list : [
    { name: "Vanessa", id: "dev-vanessa" },
    { name: "Cade", id: "dev-cade" },
  ];
}

/**
 * Entra External ID issuer for OpenID discovery. With the custom URL domain (homestead.cadejonescpa.com) the
 * authority is https://<domain>/<tenant id>/v2.0; without it, https://<tenant>.ciamlogin.com/<tenant>.onmicrosoft.com/v2.0.
 * Passkeys bind to the custom domain, which is why it must be configured before the first passkey is registered
 * (Phase 3 spec, decision 2; https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-sign-in-with-passkey).
 */
export function entraIssuer(): string {
  const base = env.entraCustomDomain ? `https://${env.entraCustomDomain}` : `https://${env.entraTenantName}.ciamlogin.com`;
  const tenantPath = env.entraTenantId || `${env.entraTenantName}.onmicrosoft.com`;
  return `${base}/${tenantPath}/v2.0`;
}
