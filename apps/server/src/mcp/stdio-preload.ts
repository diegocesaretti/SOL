// MCP over stdio owns stdout for JSON-RPC. Route diagnostic console output to stderr.
const stderr = console.error.bind(console);
console.log = stderr;
console.info = stderr;
console.debug = stderr;
