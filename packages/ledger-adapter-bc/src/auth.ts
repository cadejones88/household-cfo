/**
 * OAuth 2.0 client-credentials against Microsoft Entra ID with a certificate credential (spec: "Services and
 * secrets": one app registration per environment, certificate in Key Vault, rotated yearly).
 *
 * The client assertion is a JWT per https://learn.microsoft.com/en-us/entra/identity-platform/certificate-credentials:
 *   header  alg, typ=JWT, x5t (base64url SHA-1 of the certificate DER), x5t#S256 (base64url SHA-256 of the DER)
 *   claims  aud=https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token, iss=sub=clientId, jti, nbf, iat, exp (<= 10 min)
 * Microsoft's page now says the algorithm "should be PS256" and shows the x5t#S256 header; RS256 with x5t is the form
 * MSAL has used for years and Entra still accepts. Both headers are always sent; the algorithm is configurable and
 * defaults to RS256 as the coordinator asked. VERIFY against the sandbox registration: if Entra answers
 * AADSTS700027 (invalid client assertion signature), switch `assertionAlgorithm` to "PS256".
 *
 * Token request (https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow):
 *   POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
 *   grant_type=client_credentials&client_id=…&scope=https://api.businesscentral.dynamics.com/.default
 *   &client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer&client_assertion=…
 *
 * The PEM arrives by value from the caller (the API and the jobs read it from Key Vault by name). It is never
 * logged, never put in an error message and never kept beyond the parsed KeyObject.
 */
import { createHash, createPrivateKey, randomUUID, type KeyObject } from "node:crypto";
import { SignJWT } from "jose";
import { LedgerAdapterError } from "./errors.js";
import { redactString } from "./scrub.js";

export const BC_SCOPE = "https://api.businesscentral.dynamics.com/.default";
export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
/** Refresh when fewer than five minutes remain. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** Assertion lifetime; Microsoft asks for 5–10 minutes at most. */
export const ASSERTION_LIFETIME_S = 5 * 60;

export interface TokenProvider {
  getToken(): Promise<string>;
  /** Drop the cached token (after a 401). */
  invalidate(): void;
}

export interface CertificateCredentialConfig {
  tenantId: string;
  clientId: string;
  /** PEM text holding the private key and the certificate (Key Vault's PEM secret has both). By value; never logged. */
  pem: string;
  /** Passphrase for an encrypted private key, when there is one. */
  passphrase?: string;
  scope?: string;
  /** Defaults to https://login.microsoftonline.com. */
  authority?: string;
  assertionAlgorithm?: "RS256" | "PS256";
  fetch?: typeof fetch;
  now?: () => number;
}

export interface ParsedPemBundle {
  privateKey: KeyObject;
  certificateDer: Buffer;
  /** base64url SHA-1 of the DER, the classic `x5t` header. */
  x5t: string;
  /** base64url SHA-256 of the DER, the `x5t#S256` header. */
  x5tS256: string;
}

const CERT_RE = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/;
const KEY_RE = /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/;

export function parsePemBundle(pem: string, passphrase?: string): ParsedPemBundle {
  const certMatch = CERT_RE.exec(pem);
  const keyMatch = KEY_RE.exec(pem);
  if (!certMatch || !keyMatch) throw new LedgerAdapterError("Certificate credential PEM must contain a CERTIFICATE and a PRIVATE KEY block");
  const certificateDer = Buffer.from((certMatch[1] ?? "").replace(/\s+/g, ""), "base64");
  if (certificateDer.length === 0) throw new LedgerAdapterError("Certificate block is empty");
  let privateKey: KeyObject;
  try {
    privateKey = passphrase === undefined ? createPrivateKey(keyMatch[0]) : createPrivateKey({ key: keyMatch[0], passphrase });
  } catch (e) {
    throw new LedgerAdapterError(`Private key could not be read: ${e instanceof Error ? e.message : "unknown"}`);
  }
  if (privateKey.asymmetricKeyType !== "rsa" && privateKey.asymmetricKeyType !== "rsa-pss") {
    throw new LedgerAdapterError(`Certificate credential needs an RSA key, got ${privateKey.asymmetricKeyType ?? "unknown"}`);
  }
  return {
    privateKey,
    certificateDer,
    x5t: createHash("sha1").update(certificateDer).digest("base64url"),
    x5tS256: createHash("sha256").update(certificateDer).digest("base64url"),
  };
}

export class CertificateCredential implements TokenProvider {
  private readonly bundle: ParsedPemBundle;
  private readonly tenantId: string;
  private readonly clientId: string;
  private readonly scope: string;
  private readonly authority: string;
  private readonly alg: "RS256" | "PS256";
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached: { token: string; expiresAt: number } | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(cfg: CertificateCredentialConfig) {
    if (!cfg.tenantId || !cfg.clientId) throw new LedgerAdapterError("tenantId and clientId are required");
    this.bundle = parsePemBundle(cfg.pem, cfg.passphrase);
    this.tenantId = cfg.tenantId;
    this.clientId = cfg.clientId;
    this.scope = cfg.scope ?? BC_SCOPE;
    this.authority = (cfg.authority ?? "https://login.microsoftonline.com").replace(/\/+$/, "");
    this.alg = cfg.assertionAlgorithm ?? "RS256";
    this.fetchImpl = cfg.fetch ?? fetch;
    this.now = cfg.now ?? (() => Date.now());
  }

  get tokenEndpoint(): string {
    return `${this.authority}/${this.tenantId}/oauth2/v2.0/token`;
  }

  /** The signed client assertion; exported for the shape test, also used by getToken. */
  async buildClientAssertion(): Promise<string> {
    const nowS = Math.floor(this.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: this.alg, typ: "JWT", x5t: this.bundle.x5t, "x5t#S256": this.bundle.x5tS256 })
      .setAudience(this.tokenEndpoint)
      .setIssuer(this.clientId)
      .setSubject(this.clientId)
      .setJti(randomUUID())
      .setNotBefore(nowS)
      .setIssuedAt(nowS)
      .setExpirationTime(nowS + ASSERTION_LIFETIME_S)
      .sign(this.bundle.privateKey);
  }

  async getToken(): Promise<string> {
    const c = this.cached;
    if (c && c.expiresAt - this.now() > TOKEN_REFRESH_MARGIN_MS) return c.token;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.requestToken().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async requestToken(): Promise<string> {
    const assertion = await this.buildClientAssertion();
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      scope: this.scope,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: assertion,
    });
    let res: Response;
    try {
      res = await this.fetchImpl(this.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: body.toString(),
      });
    } catch (e) {
      throw new LedgerAdapterError(`Token request failed: ${e instanceof Error ? e.message : "network error"}`);
    }
    const text = await res.text();
    let json: { access_token?: string; expires_in?: number; error?: string; error_description?: string } = {};
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      // handled below
    }
    if (!res.ok || !json.access_token) {
      // error_description carries the AADSTS code, which is safe and useful; it never carries the token.
      throw new LedgerAdapterError(`Token request refused (${res.status}): ${redactString(json.error ?? "")} ${redactString(json.error_description ?? "")}`.trim());
    }
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    this.cached = { token: json.access_token, expiresAt: this.now() + expiresIn * 1000 };
    return json.access_token;
  }
}

/** A fixed token for tests and for the MockBcServer, which accepts any bearer token. */
export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string = "test-token") {}
  async getToken(): Promise<string> {
    return this.token;
  }
  invalidate(): void {
    /* nothing cached */
  }
}
