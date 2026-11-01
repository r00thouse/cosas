// Role mapping (§4.1/§5.3 step 6). This is where a real deployment got demoted to
// read-only: Kanidm sends the person's group names, and treating `groups` as a list of
// roles turned every member into a reader.
import assert from "node:assert/strict";
import test from "node:test";
import { groupNames, mergeClaims, roleDiagnostics, roleFromClaims } from "../../oidc.js";
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

test("group values are normalised: names, spns and uuids all work (§4.2)", () => {
  const uuid = "9f2a1c1e-0000-4000-8000-000000000000";
  // `groups` scope: uuids and spns mixed together.
  assert.equal(roleFromClaims({ groups: [uuid, "cosas_admin@idm.example.com"] }, "cosas_admin"), "admin");
  // `groups_name` scope: bare names.
  assert.equal(roleFromClaims({ groups: ["cosas_admin"] }, "cosas_admin"), "admin");
  // `groups_spn` scope: spns only, and case does not matter.
  assert.equal(roleFromClaims({ groups: ["COSAS_Admin@IDM.example.com"] }, "cosas_admin"), "admin");
  assert.equal(roleFromClaims({ groups: [uuid] }, "cosas_admin"), "member");
  assert.equal(roleFromClaims({ groups: ["inventory_users@idm.example.com"] }, "cosas_admin"), "member");
});

test("groupNames drops uuids and keeps bare names", () => {
  assert.deepEqual(
    groupNames(["2f5a-...", "A@B.test", "  cosas_admin  "].filter((v) => !v.startsWith("2f5a"))),
    ["a", "cosas_admin"],
  );
});

test("config reads OIDC_ADMIN_GROUP and defaults to unset", () => {
  assert.equal(loadConfig({}).oidcAdminGroup, "");
  assert.equal(loadConfig({ OIDC_ADMIN_GROUP: " cosas_admin " }).oidcAdminGroup, "cosas_admin");
});

test("userinfo claims fill the gaps a Kanidm id_token leaves (§5.3)", () => {
  const idToken = { iss: "https://idm", aud: "cosas", sub: "u1", exp: 1, iat: 0 };
  const merged = mergeClaims(idToken, { sub: "u1", name: "alice", groups: ["cosas_admin@idm.example.com"] });
  assert.deepEqual(merged.groups, ["cosas_admin@idm.example.com"]);
  assert.equal(merged.name, "alice");
  // Protocol fields come from the verified id_token, never from the userinfo response.
  const hostile = mergeClaims(idToken, { iss: "https://evil", aud: "other", sub: "other", exp: 2 });
  assert.equal(hostile.iss, "https://idm");
  assert.equal(hostile.aud, "cosas");
  assert.equal(hostile.sub, "u1");
  assert.equal(hostile.exp, 1);
  // A missing userinfo response changes nothing.
  assert.equal(mergeClaims(idToken, null), idToken);
});

test("the login log names the claim source, the group and the decision", () => {
  const d = roleDiagnostics({ sub: "u1", groups: ["inventory_users@idm.example.com"] }, "cosas_admin");
  assert.deepEqual(d, {
    claims: ["groups", "sub"],
    roles: null,
    groups: ["inventory_users@idm.example.com"],
    group_names: ["inventory_users"],
    admin_group: "cosas_admin",
    role: "member",
  });
});
