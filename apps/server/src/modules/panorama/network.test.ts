import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredNeuralPrinters, neuralSourceKey, projectNeuralNetwork } from "./network.js";
import type { TimelineItem } from "../life/timeline.js";

test("Panorama neural source mapping is stable", () => {
  assert.equal(neuralSourceKey("nexo-whatsapp"), "whatsapp");
  assert.equal(neuralSourceKey("BWA-3D"), "bwa");
  assert.equal(neuralSourceKey("google_calendar"), "calendar");
  assert.equal(neuralSourceKey(undefined, "task"), "calendar");
  assert.equal(neuralSourceKey(undefined, "source"), "life");
});

test("neural snapshot is scoped to the supplied Life items and never includes private text", () => {
  const now = new Date("2026-10-14T18:00:00.000Z");
  const item: TimelineItem = {
    id: "opaque1", type: "source", occurredAt: "2026-10-14T17:54:00.000Z",
    title: "PRIVATE TITLE MUST NOT LEAK", summary: "PRIVATE SUMMARY MUST NOT LEAK",
    visibility: "private", provider: "whatsapp",
    metadata: { intelligencePriority: "high", confidential: "DO NOT LEAK" },
  };
  const old: TimelineItem = {
    ...item, id: "old", occurredAt: "2026-10-10T00:00:00.000Z", provider: "gmail",
  };
  const edition = { id: "daily", asOf: "2026-10-14T16:00:00.000Z", newCount: 1 };
  const snapshot = projectNeuralNetwork([item, old], edition, now);
  assert.equal(snapshot.nodes.find(x => x.id === "whatsapp")?.count, 1);
  assert.equal(snapshot.nodes.find(x => x.id === "gmail")?.count, 0);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0]?.id, "source:opaque1");
  assert.equal(snapshot.events[0]?.intensity, 1.7);
  assert.ok(snapshot.edges.some(x => x.source === "whatsapp" && x.target === "panorama"));
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes("PRIVATE"));
  assert.ok(!serialized.includes("DO NOT LEAK"));
  assert.equal(snapshot.edition?.id, "daily");
});

test("neural snapshot stays quiet without actual events", () => {
  const snapshot = projectNeuralNetwork([], null, new Date("2026-10-14T18:00:00Z"));
  assert.equal(snapshot.events.length, 0);
  assert.equal(snapshot.nodes.find(x => x.id === "whatsapp")?.activity, 0);
  assert.equal(snapshot.nodes.find(x => x.id === "panorama")?.center, true);
});

test("real messages and recorded sales become leaf relays under subcenters", () => {
  const now = new Date("2026-10-14T21:30:00.000Z");
  const items: TimelineItem[] = [
    { id:"msg-a",type:"source",occurredAt:"2026-10-14T21:29:00.000Z",title:"Private from Mariana",summary:"Don't leak the body",provider:"whatsapp",visibility:"private" },
    { id:"sale-b",type:"source",occurredAt:"2026-10-14T21:28:00.000Z",title:"Secret buyer name",provider:"mercadolibre",metadata:{recordType:"sale",orderId:"very-secret-order"},visibility:"private" },
    { id:"printer-c",type:"source",occurredAt:"2026-10-14T21:27:00.000Z",title:"Super secret GCode",provider:"bambuddy",metadata:{printerName:"A1 MINI C",serialNumber:"super secret serial"},visibility:"private" },
    { id:"home-d",type:"source",occurredAt:"2026-10-14T21:26:00.000Z",title:"home occupant",provider:"home_assistant",metadata:{entityId:"climate.cocina"},visibility:"private" },
  ];
  const snap = projectNeuralNetwork(items, null, now, ["A1 MINI A","A1 MINI B","A1 MINI C"]);
  const message = snap.nodes.find(x => x.id === "event:source:msg-a");
  const sale = snap.nodes.find(x => x.id === "event:source:sale-b");
  const printer = snap.nodes.find(x => x.id === "printer:a1 mini c");
  const home = snap.nodes.find(x => x.id === "device:climate.cocina");
  assert.equal(message?.role,"event");
  assert.equal(message?.type,"relay");
  assert.equal(message?.label,"Mensaje");
  assert.equal(sale?.label,"Venta");
  assert.equal(message?.parent,"group:whatsapp:messages");
  assert.equal(sale?.parent,"group:bwa:sales");
  assert.equal(printer?.type,"printer");
  assert.equal(printer?.parent,"group:bambuddy:printers");
  assert.equal(printer?.count,1);
  assert.equal(home?.parent,"group:home:devices");
  assert.equal(home?.type,"device");
  assert.equal(snap.nodes.filter(x=>x.type==="printer").length,3);
  assert.ok(snap.edges.some(e=>e.source===message?.id&&e.target===message?.parent));
  const serialized=JSON.stringify(snap);
  for (const secret of ["Private from Mariana","Don't leak","Secret buyer","very-secret-order","Super secret GCode","super secret serial","home occupant"]) {
    assert.equal(serialized.includes(secret),false);
  }
  assert.equal(snap.events.length,4);
});
test("configuration validates printer roster names and deduplicates", () => {
  assert.deepEqual(configuredNeuralPrinters("A1 MINI A,A1 MINI B,A1 MINI A"),["A1 MINI A","A1 MINI B"]);
  assert.deepEqual(configuredNeuralPrinters("valid, dangerous@test,https://url, another"),["valid","another"]);
});
