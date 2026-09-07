function websocketUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/websocket`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason || new Error("aborted"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export class HomeAssistantClient {
  constructor({ baseUrl, token, cache, reconcileSeconds = 300, onStateChanged, onConnectionState }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.cache = cache;
    this.reconcileSeconds = reconcileSeconds;
    this.onStateChanged = onStateChanged;
    this.onConnectionState = onConnectionState;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.bufferEvents = false;
    this.eventBuffer = [];
    this.reconcileTimer = null;
    this.stopController = new AbortController();
    this.connected = false;
  }

  async start() {
    let failures = 0;
    while (!this.stopController.signal.aborted) {
      try {
        await this.connectAndRun();
        failures = 0;
      } catch (error) {
        if (this.stopController.signal.aborted) break;
        failures += 1;
        this.connected = false;
        this.cache.setConnected(false);
        if (this.reconcileTimer) clearInterval(this.reconcileTimer);
        this.reconcileTimer = null;
        try { this.ws?.close(); } catch {}
        this.ws = null;
        for (const { reject } of this.pending.values()) reject(new Error("Home Assistant connection reset"));
        this.pending.clear();
        await Promise.resolve(this.onConnectionState?.("error", error)).catch(() => undefined);
        console.warn(`Home Assistant connection failed: ${error?.message || error}`);
        const waitMs = Math.min(30000, 1000 * 2 ** Math.min(5, failures - 1)) + Math.floor(Math.random() * 500);
        await delay(waitMs, this.stopController.signal).catch(() => undefined);
      }
    }
  }

  async stop() {
    this.stopController.abort();
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.connected = false;
    this.cache.setConnected(false);
    for (const { reject } of this.pending.values()) reject(new Error("Home Assistant plugin stopped"));
    this.pending.clear();
    await Promise.resolve(this.onConnectionState?.("disconnected")).catch(() => undefined);
  }

  async command(type, payload = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.connected) {
      throw new Error("home_assistant_not_connected");
    }
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Home Assistant command timeout: ${type}`));
      }, 15000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); }
      });
      this.ws.send(JSON.stringify({ id, type, ...payload }));
    });
  }

  async optionalCommand(type, fallback) {
    try {
      return await this.command(type);
    } catch (error) {
      console.warn(`Home Assistant optional command ${type} unavailable: ${error?.message || error}`);
      return fallback;
    }
  }

  async callService(domain, service, serviceData = {}, target = {}, returnResponse = false) {
    return await this.command("call_service", {
      domain,
      service,
      service_data: serviceData,
      target,
      ...(returnResponse ? { return_response: true } : {})
    });
  }

  async connectAndRun() {
    const socket = new WebSocket(websocketUrl(this.baseUrl));
    this.ws = socket;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Home Assistant websocket open timeout")), 12000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Home Assistant websocket error")); }, { once: true });
    });

    const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
    const authRequired = await this.nextMessage(socket, (message) => message?.type === "auth_required", 10000);
    if (!authRequired) throw new Error("Home Assistant did not request authentication");
    socket.send(JSON.stringify({ type: "auth", access_token: this.token }));
    const auth = await this.nextMessage(socket, (message) => message?.type === "auth_ok" || message?.type === "auth_invalid", 10000);
    if (auth?.type !== "auth_ok") throw new Error(`Home Assistant authentication failed${auth?.message ? `: ${auth.message}` : ""}`);

    socket.addEventListener("message", (event) => this.handleMessage(event));
    this.connected = true;
    this.cache.setConnected(true);

    // Subscribe first and buffer events while taking the initial snapshot. This closes
    // the race where an entity changes between get_states and subscription activation.
    this.bufferEvents = true;
    this.eventBuffer = [];
    await this.command("subscribe_events", { event_type: "state_changed" });
    await this.reconcile(true);
    const buffered = this.eventBuffer.splice(0);
    this.bufferEvents = false;
    for (const event of buffered) this.applyStateEvent(event);

    await Promise.resolve(this.onConnectionState?.("connected")).catch(() => undefined);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = setInterval(() => {
      void this.reconcile(false).catch((error) => console.warn(`HA reconcile failed: ${error?.message || error}`));
    }, Math.max(30, this.reconcileSeconds) * 1000);
    this.reconcileTimer.unref?.();

    console.log(JSON.stringify({
      type: "sol.plugin.ready",
      health: "healthy",
      details: { provider: "home_assistant", cache: this.cache.status() }
    }));

    await closed;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    this.connected = false;
    this.cache.setConnected(false);
    for (const { reject } of this.pending.values()) reject(new Error("Home Assistant websocket closed"));
    this.pending.clear();
    await Promise.resolve(this.onConnectionState?.("disconnected")).catch(() => undefined);
    if (!this.stopController.signal.aborted) throw new Error("Home Assistant websocket closed");
  }

  async reconcile(includeStates) {
    const statesPromise = includeStates ? this.command("get_states") : Promise.resolve(null);
    const [states, entities, devices, areas, services] = await Promise.all([
      statesPromise,
      this.optionalCommand("config/entity_registry/list", Object.values(this.cache.entities)),
      this.optionalCommand("config/device_registry/list", Object.values(this.cache.devices)),
      this.optionalCommand("config/area_registry/list", Object.values(this.cache.areas)),
      this.optionalCommand("get_services", this.cache.services)
    ]);
    if (includeStates) this.cache.installSnapshot({ states, entities, devices, areas, services });
    else this.cache.replaceRegistries({ entities, devices, areas, services });
  }

  handleMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }

    if (message.type === "result" && Number.isInteger(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.success) pending.resolve(message.result);
      else pending.reject(new Error(message.error?.message || message.error?.code || "Home Assistant command failed"));
      return;
    }

    if (message.type === "event" && message.event?.event_type === "state_changed") {
      if (this.bufferEvents) this.eventBuffer.push(message.event);
      else this.applyStateEvent(message.event);
    }
  }

  applyStateEvent(event) {
    if (!this.cache.applyStateChanged(event)) return;
    Promise.resolve(this.onStateChanged?.(event)).catch((error) => {
      console.warn(`HA state change hook failed: ${error?.message || error}`);
    });
  }

  nextMessage(socket, predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Home Assistant websocket handshake timeout"));
      }, timeoutMs);
      const onMessage = (event) => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (!predicate(message)) return;
        cleanup();
        resolve(message);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Home Assistant websocket closed during handshake"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
      };
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose, { once: true });
    });
  }
}
