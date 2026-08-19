import type { HouseholdRole, MemberId } from "../identity/types.js";

export type VisibilityScope = "private" | "shared" | "family" | "project" | "system";

export interface ResourceAccess {
  householdId: string;
  ownerMemberId?: MemberId;
  visibility: VisibilityScope;
  allowedMemberIds?: MemberId[];
}

export interface RequestPrincipal {
  householdId: string;
  memberId: MemberId;
  role: HouseholdRole;
}

/**
 * This is deliberately conservative. More granular project/parental rules will
 * live here, before retrieval and before AI context construction.
 */
export function canRead(principal: RequestPrincipal, resource: ResourceAccess): boolean {
  if (principal.householdId !== resource.householdId) return false;
  if (resource.ownerMemberId === principal.memberId) return true;

  switch (resource.visibility) {
    case "family":
      return principal.role !== "guest";
    case "shared":
    case "project":
      return resource.allowedMemberIds?.includes(principal.memberId) ?? false;
    case "system":
      return principal.role === "owner" || principal.role === "adult";
    case "private":
    default:
      return false;
  }
}
