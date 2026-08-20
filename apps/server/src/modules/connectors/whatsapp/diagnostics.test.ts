import assert from "node:assert/strict";
import test from "node:test";
import {
  clearWhatsappDiagnostics,
  listWhatsappDiagnostics,
  logWhatsappDiagnostic,
  observeWhatsappRuntime,
} from "./diagnostics.js";

test("diagnostics redact likely secret and message payload fields", () => {
  const accountId = "00000000-0000-0000-0000-000000000001";
  clearWhatsappDiagnostics(accountId);
  logWhatsappDiagnostic(accountId, "error", "connect_failed", "boom", {
    statusCode: 428,
    token: "must-not-appear",
    qrData: "must-not-appear",
    messagePayload: "must-not-appear",
    state: "error",
  });
  const [entry] = listWhatsappDiagnostics(accountId);
  assert.equal(entry?.details?.statusCode, 428);
  assert.equal(entry?.details?.state, "error");
  assert.equal("token" in (entry?.details ?? {}), false);
  assert.equal("qrData" in (entry?.details ?? {}), false);
  assert.equal("messagePayload" in (entry?.details ?? {}), false);
});

test("runtime observations only append when meaningful state changes", () => {
  const accountId = "00000000-0000-0000-0000-000000000002";
  clearWhatsappDiagnostics(accountId);
  const observation = {
    state: "connecting",
    reconnectAttempt: 0,
    updatedAt: new Date().toISOString(),
  };
  observeWhatsappRuntime(accountId, observation);
  observeWhatsappRuntime(accountId, { ...observation, updatedAt: new Date(Date.now() + 1000).toISOString() });
  assert.equal(listWhatsappDiagnostics(accountId).length, 1);
  observeWhatsappRuntime(accountId, { ...observation, state: "qr", updatedAt: new Date().toISOString() });
  assert.equal(listWhatsappDiagnostics(accountId).length, 2);
});
