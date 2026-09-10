import assert from "node:assert/strict";
import test from "node:test";
import { canManageWorkspace, workspaceLabel } from "../src/lib/teamWorkspace.js";
test("personal and verified Team administrators retain configuration", () => {
  assert.equal(canManageWorkspace({state:"personal",role:null}),true);
  for (const role of ["owner", "admin"] as const) assert.equal(canManageWorkspace({state:"team",role}),true);
});
test("members, billing roles and unverified contexts have no instance administration", () => {
  for (const role of ["member", "billing", null] as const) assert.equal(canManageWorkspace({state:"team",role}),false);
  assert.equal(canManageWorkspace({state:"unavailable",role:"owner"}),false);
  assert.equal(workspaceLabel({state:"team",role:"member"}),"Team workspace");
});
