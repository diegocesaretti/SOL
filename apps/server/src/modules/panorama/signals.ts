import { EventEmitter } from "node:events";

export interface PanoramaEditionSignal {
  householdId: string;
  memberId: string;
  editionId: string;
  createdAt: string;
}

// In-process only; the latest persisted edition is re-read when Pulse reconnects.
const channel = new EventEmitter();
channel.setMaxListeners(100);
export function publishPanoramaEdition(signal: PanoramaEditionSignal): void {
  channel.emit("edition", signal);
}
export function subscribePanoramaEditions(listener: (signal: PanoramaEditionSignal) => void): () => void {
  channel.on("edition", listener);
  return () => channel.off("edition", listener);
}
