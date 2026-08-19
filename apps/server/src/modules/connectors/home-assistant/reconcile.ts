import { fetchHomeAssistantStates } from "./client.js";
import { ingestHomeAssistantStateChange } from "./ingest.js";
import {
  getHomeAssistantAccount,
  listSelectedHomeAssistantEntities,
  loadHomeAssistantCredential,
} from "./repository.js";

/**
 * Refreshes only entities explicitly selected by the household. This repairs current-state
 * drift after SOL was offline without turning missed historical transitions into invented
 * timeline events.
 */
export async function reconcileSelectedHomeAssistantStates(sourceAccountId: string): Promise<number> {
  const [account, credential, selected] = await Promise.all([
    getHomeAssistantAccount(sourceAccountId),
    loadHomeAssistantCredential(sourceAccountId),
    listSelectedHomeAssistantEntities(sourceAccountId),
  ]);
  if (!account || !credential || !selected.length) return 0;
  const states = await fetchHomeAssistantStates(credential.baseUrl, credential.token);
  const stateMap = new Map(states.map((state) => [state.entity_id, state]));
  let refreshed = 0;
  const now = new Date().toISOString();
  for (const entity of selected) {
    const current = stateMap.get(entity.entityId);
    if (!current) continue;
    await ingestHomeAssistantStateChange({
      householdId: account.householdId,
      sourceAccountId,
      entity,
      oldState: current,
      newState: current,
      timeFired: now,
    });
    refreshed += 1;
  }
  return refreshed;
}
