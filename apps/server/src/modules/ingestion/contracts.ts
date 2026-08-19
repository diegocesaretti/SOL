import type {
  HouseholdId,
  MemberId,
  SourceAccountId,
  SourceProvider,
} from "../identity/types.js";
import type { VisibilityScope } from "../security/access.js";

/** A provider-neutral item produced by every source connector. */
export interface IngestedItem {
  householdId: HouseholdId;
  sourceAccountId: SourceAccountId;
  provider: SourceProvider;
  externalId: string;
  kind: "message" | "email" | "calendar_event" | "document" | "sensor_event" | "other";
  occurredAt: string;
  observedAt: string;
  ownerMemberId?: MemberId;
  visibility: VisibilityScope;
  title?: string;
  text?: string;
  rawMetadata: Record<string, unknown>;
}

export interface SourceConnector {
  readonly provider: SourceProvider;
  start(): Promise<void>;
  stop(): Promise<void>;
  sync(accountId: SourceAccountId): Promise<void>;
}
