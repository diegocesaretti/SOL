export interface DomainEvent<TPayload = unknown> {
  id: string;
  type: string;
  occurredAt: string;
  householdId: string;
  actorMemberId?: string;
  payload: TPayload;
}

export type EventHandler<TPayload = unknown> = (
  event: DomainEvent<TPayload>,
) => void | Promise<void>;

export interface EventBus {
  publish<TPayload>(event: DomainEvent<TPayload>): Promise<void>;
  subscribe<TPayload>(type: string, handler: EventHandler<TPayload>): () => void;
}

export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();

  async publish<TPayload>(event: DomainEvent<TPayload>): Promise<void> {
    const handlers = this.handlers.get(event.type);
    if (!handlers) return;

    await Promise.all(
      [...handlers].map((handler) => handler(event as DomainEvent<unknown>)),
    );
  }

  subscribe<TPayload>(type: string, handler: EventHandler<TPayload>): () => void {
    const handlers = this.handlers.get(type) ?? new Set<EventHandler>();
    handlers.add(handler as EventHandler);
    this.handlers.set(type, handlers);

    return () => {
      handlers.delete(handler as EventHandler);
      if (handlers.size === 0) this.handlers.delete(type);
    };
  }
}
