// All settings come from the environment (SPEC.md §10.1). No dotenv dependency:
// the containers get their values from Compose; local runs get them from the shell.
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
    sessionSecret: env.SESSION_SECRET || "dev-session-secret-that-is-long-enough-000000",
    codeSecret: env.CODE_SECRET || "dev-code-secret-that-is-long-enough-0000000",
    oidcDiscoveryUrl:
      env.OIDC_DISCOVERY_URL || "http://localhost:9000/oauth2/openid/cosas/.well-known/openid-configuration",
    oidcClientId: env.OIDC_CLIENT_ID || "cosas",
    oidcClientSecret: env.OIDC_CLIENT_SECRET || "dev-client-secret",
    oidcScopes: env.OIDC_SCOPES || "openid profile",
    trustProxy: env.TRUST_PROXY === "1",
    logLevel: env.LOG_LEVEL || "info",
    skipDiscoveryCheck: env.SKIP_DISCOVERY_CHECK === "1",
    // Optional override; discovered at boot otherwise (§4.3 uses discovery's value).
    oidcIssuer: env.OIDC_ISSUER || "",
  };
}
