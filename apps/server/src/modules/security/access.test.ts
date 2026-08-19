import assert from "node:assert/strict";
import test from "node:test";
import { canRead, type RequestPrincipal, type ResourceAccess } from "./access.js";

const owner: RequestPrincipal = {
  householdId: "home-a",
  memberId: "diego",
  role: "owner",
};

const adult: RequestPrincipal = {
  householdId: "home-a",
  memberId: "mariana",
  role: "adult",
};

const child: RequestPrincipal = {
  householdId: "home-a",
  memberId: "luca",
  role: "child",
};

function resource(overrides: Partial<ResourceAccess> = {}): ResourceAccess {
  return {
    householdId: "home-a",
    ownerMemberId: "diego",
    visibility: "private",
    ...overrides,
  };
}

test("cross-household access is always denied", () => {
  assert.equal(
    canRead(owner, resource({ householdId: "home-b", visibility: "family" })),
    false,
  );
});

test("a member can read their own private resource", () => {
  assert.equal(canRead(owner, resource()), true);
});

test("even a household owner cannot read another member private resource by default", () => {
  assert.equal(
    canRead(owner, resource({ ownerMemberId: "mariana", visibility: "private" })),
    false,
  );
});

test("family visibility is available to non-guests in the household", () => {
  assert.equal(
    canRead(adult, resource({ ownerMemberId: undefined, visibility: "family" })),
    true,
  );
  assert.equal(
    canRead(child, resource({ ownerMemberId: undefined, visibility: "family" })),
    true,
  );
});

test("shared and project resources require an explicit grant", () => {
  const shared = resource({
    ownerMemberId: "diego",
    visibility: "shared",
    allowedMemberIds: ["mariana"],
  });
  assert.equal(canRead(adult, shared), true);
  assert.equal(canRead(child, shared), false);
});

test("system resources are limited to owner and adult roles", () => {
  const system = resource({ ownerMemberId: undefined, visibility: "system" });
  assert.equal(canRead(owner, system), true);
  assert.equal(canRead(adult, system), true);
  assert.equal(canRead(child, system), false);
});
