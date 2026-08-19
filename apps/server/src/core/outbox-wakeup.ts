type WakeHandler = () => void;

let wakeHandler: WakeHandler | undefined;

export function installOutboxWake(handler: WakeHandler): () => void {
  wakeHandler = handler;
  return () => {
    if (wakeHandler === handler) wakeHandler = undefined;
  };
}

export function wakeOutbox(): void {
  wakeHandler?.();
}
