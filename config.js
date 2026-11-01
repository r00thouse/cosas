// All settings come from the environment (SPEC.md §10.1). No dotenv dependency:
// the containers get their values from Compose; local runs get them from the shell.
import { dirname, join } from "node:path";

export function loadConfig(env = process.env) {
  const num = (key, dflt) => {
    const v = env[key] === undefined || env[key] === "" ? dflt : Number(env[key]);
    if (!Number.isInteger(v) || v < 0) throw new Error(`${key} must be a non-negative integer`);
    return v;
  };
  if (env.CODE_SECRET && Buffer.byteLength(env.CODE_SECRET) < 32) throw new Error("CODE_SECRET must be at least 32 bytes");
  if (env.SESSION_SECRET && Buffer.byteLength(env.SESSION_SECRET) < 32) {
    throw new Error("SESSION_SECRET must be at least 32 bytes");
  }
  return {
    port: num("PORT", 8080),
    publicOrigin: (env.PUBLIC_ORIGIN || "http://localhost:8080").replace(/\/+$/, ""),
    dbPath: env.DB_PATH || "data/cosas.db",
    // Item photos live next to the database by default (§8.8); PHOTO_DIR overrides.
    photoDir: env.PHOTO_DIR || join(dirname(env.DB_PATH || "data/cosas.db"), "photos"),
    sessionSecret: env.SESSION_SECRET || "dev-session-secret-that-is-long-enough-000000",
    codeSecret: env.CODE_SECRET || "dev-code-secret-that-is-long-enough-0000000",
    oidcDiscoveryUrl:
      env.OIDC_DISCOVERY_URL || "http://localhost:9010/oauth2/openid/cosas/.well-known/openid-configuration",
    oidcClientId: env.OIDC_CLIENT_ID || "cosas",
    oidcClientSecret: env.OIDC_CLIENT_SECRET || "dev-client-secret",
    // `groups_name` must be requested or Kanidm never adds the `groups` claim, even when
    // the client's scope map allows it — that silently demoted real deployments (§4.2).
    oidcScopes: env.OIDC_SCOPES || "openid profile groups_name",
    // Optional (§4.1): the Kanidm group whose members may write. Unset means "anyone the
    // IdP lets in", the v1 default — set it to split admins from readers.
    oidcAdminGroup: (env.OIDC_ADMIN_GROUP || "").trim(),
    trustProxy: env.TRUST_PROXY === "1",
    logLevel: env.LOG_LEVEL || "info",
    skipDiscoveryCheck: env.SKIP_DISCOVERY_CHECK === "1",
    // Optional override; discovered at boot otherwise (§4.3 uses discovery's value).
    oidcIssuer: env.OIDC_ISSUER || "",
  };
}
