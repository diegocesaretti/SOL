function emit(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

emit({
  type: "sol.plugin.ready",
  health: "healthy",
  details: { greeting: "Hola desde Hello SOL", pid: process.pid },
});
emit({ type: "sol.plugin.log", level: "info", message: "Hello SOL iniciado correctamente" });

const heartbeat = setInterval(() => {
  emit({
    type: "sol.plugin.health",
    status: "healthy",
    details: { uptimeSeconds: Math.round(process.uptime()) },
  });
}, 15_000);

function shutdown() {
  clearInterval(heartbeat);
  emit({ type: "sol.plugin.log", level: "info", message: "Hello SOL detenido por el host" });
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
