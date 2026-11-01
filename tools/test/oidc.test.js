// Role mapping (§4.1/§5.3 step 6). This is where a real deployment got demoted to
// read-only: Kanidm sends the person's group names, and treating `groups` as a list of
// roles turned every member into a reader.
import assert from "node:assert/strict";
import test from "node:test";
import { roleFromClaims } from "../../oidc.js";
import { loadConfig } from "../../config.js";

test("the v1 default: anyone the IdP let in is an admin", () => {
  assert.equal(roleFromClaims({}), "admin");
  assert.equal(roleFromClaims({ sub: "x", preferred_username: "alice" }), "admin");
});

test("a Kanidm `groups` claim does not demote anybody", () => {
  // The bug: group names are deployment-specific, so looking for "admin" among them
  // made every real instance read-only.
  assert.equal(roleFromClaims({ groups: ["inventory_users"] }), "admin");
  assert.equal(roleFromClaims({ groups: ["inventory_users", "staff"] }), "admin");
});

test("an explicit `roles` claim decides both ways", () => {
  assert.equal(roleFromClaims({ roles: ["admin"] }), "admin");
  assert.equal(roleFromClaims({ roles: ["member"] }), "member");
  assert.equal(roleFromClaims({ roles: [] }), "member");
  assert.equal(roleFromClaims({ roles: "admin staff" }), "admin");
  assert.equal(roleFromClaims({ roles: ["reader"], groups: ["inventory_users"] }), "member");
});

test("OIDC_ADMIN_GROUP opts into a real split", () => {
  assert.equal(roleFromClaims({ groups: ["cosas_admin"] }, "cosas_admin"), "admin");
  assert.equal(roleFromClaims({ groups: ["inventory_users"] }, "cosas_admin"), "member");
  assert.equal(roleFromClaims({}, "cosas_admin"), "member");
  // An explicit role claim still wins over the group.
  assert.equal(roleFromClaims({ roles: ["admin"], groups: [] }, "cosas_admin"), "admin");
});

test("config reads OIDC_ADMIN_GROUP and defaults to unset", () => {
  assert.equal(loadConfig({}).oidcAdminGroup, "");
  assert.equal(loadConfig({ OIDC_ADMIN_GROUP: " cosas_admin " }).oidcAdminGroup, "cosas_admin");
});
