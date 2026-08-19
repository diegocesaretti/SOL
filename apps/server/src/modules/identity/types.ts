export type HouseholdId = string;
export type MemberId = string;
export type SourceAccountId = string;

export type HouseholdRole = "owner" | "adult" | "member" | "child" | "guest";
export type MemberStatus = "active" | "invited" | "disabled";

export interface Household {
  id: HouseholdId;
  name: string;
  timezone: string;
  createdAt: string;
}

export interface Member {
  id: MemberId;
  householdId: HouseholdId;
  displayName: string;
  role: HouseholdRole;
  status: MemberStatus;
  locale?: string;
  timezone?: string;
}

export type SourceProvider =
  | "whatsapp"
  | "google"
  | "gmail"
  | "google_calendar"
  | "home_assistant"
  | "filesystem"
  | "voice"
  | (string & {});

export interface SourceAccount {
  id: SourceAccountId;
  householdId: HouseholdId;
  ownerMemberId?: MemberId;
  provider: SourceProvider;
  label: string;
  status: "connected" | "disconnected" | "error";
  secretRef?: string;
}
