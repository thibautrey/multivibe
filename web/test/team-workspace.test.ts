import assert from "node:assert/strict";
import test from "node:test";
import { canManageWorkspace, workspaceLabel } from "../src/lib/teamWorkspace.js";
test("personal and verified Team administrators retain configuration", () => {
  assert.equal(canManageWorkspace({state:"personal",role:null}),true);
  for (const role of ["owner", "admin"] as const) assert.equal(canManageWorkspace({state:"team",role}),true);
});
test("verified Team members and billing roles have no instance administration", () => {
  for (const role of ["member", "billing", null] as const) assert.equal(canManageWorkspace({state:"team",role}),false);
  assert.equal(workspaceLabel({state:"team",role:"member"}),"Team workspace");
});
test("an unavailable optional Team lookup keeps the personal workspace accessible", () => {
  assert.equal(canManageWorkspace({state:"unavailable",role:null}),true);
  assert.equal(workspaceLabel({state:"unavailable",role:null}),"Personal workspace");
});
