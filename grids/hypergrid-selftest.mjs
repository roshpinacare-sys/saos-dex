#!/usr/bin/env node
/* HYPERGRID-POLICY selftest — G78-b-R1 · node-only, zero deps, fail-honest.
 * Validates: fail-closed loader paths (missing file, armed!=true, enabled!=true,
 * allowTransfersOut HARD GUARD, malformed caps) · ladder math · ops day-cap ledger
 * · C3-aware tick planning · receipt schema. Exits 1 on any failure. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { loadHyperGridPolicy, deriveLadder, opsDayLedger, recordOps, dayCapRemaining, planTick, receiptRow, RECEIPT_SCHEMA } from "./hypergrid-policy.mjs";

let pass = 0, fail = 0;
const T = (name, fn) => { try { fn(); pass++; console.log(`  PASS ${name}`); } catch (e) { fail++; console.error(`  FAIL ${name}: ${e.message}`); } };

console.log("[hypergrid-selftest] start");

T("policy missing → fail-closed", () => {
  const r = loadHyperGridPolicy(path.join(os.tmpdir(), `hg-absent-${Date.now()}`));
  assert.equal(r.ok, false); assert.match(r.reason, /fail-closed/);
});
T("armed!==true → fail-closed", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hg-"));
  fs.writeFileSync(path.join(d, "exec-armed.json"), JSON.stringify({ armed: false, hyperGrid: { enabled: true, tickMs: 3000, levels: 10, spacingBps: 15, ttlSec: 60, maxOpsPerTick: 24, opsDayCap: 32000 } }));
  const r = loadHyperGridPolicy(d);
  assert.equal(r.ok, false); assert.match(r.reason, /armed/);
});
T("allowTransfersOut!==false → HARD GUARD refusal", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hg-"));
  fs.writeFileSync(path.join(d, "exec-armed.json"), JSON.stringify({ armed: true, policy: { allowTransfersOut: true }, hyperGrid: { enabled: true, tickMs: 3000, levels: 10, spacingBps: 15, ttlSec: 60, maxOpsPerTick: 24, opsDayCap: 32000 } }));
  const r = loadHyperGridPolicy(d);
  assert.equal(r.ok, false); assert.match(r.reason, /HARD GUARD/);
});
T("malformed caps → fail-closed", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hg-"));
  fs.writeFileSync(path.join(d, "exec-armed.json"), JSON.stringify({ armed: true, policy: { allowTransfersOut: false }, hyperGrid: { enabled: true, tickMs: 3000, levels: 10, spacingBps: -1, ttlSec: 60, maxOpsPerTick: 24, opsDayCap: 32000 } }));
  assert.equal(loadHyperGridPolicy(d).ok, false);
});
T("REAL armed vault policy loads green", () => {
  const r = loadHyperGridPolicy();
  assert.equal(r.ok, true, r.reason ?? "");
  assert.equal(r.policy.tickMs, 3000); assert.equal(r.policy.levels, 10);
  assert.equal(r.policy.spacingBps, 15); assert.equal(r.policy.ttlSec, 60);
  assert.equal(r.policy.maxOpsPerTick, 24); assert.equal(r.policy.opsDayCap, 32000);
  assert.equal(r.policy.allowTransfersOut, false);
});
T("ladder math: 10 levels × 15bps around mid 1017", () => {
  const { buy, sell } = deriveLadder({ levels: 10, spacingBps: 15 }, 1017);
  assert.equal(buy.length, 10); assert.equal(sell.length, 10);
  assert.equal(buy[0], 1015); assert.equal(sell[0], 1019); // ±15bps ≈ ±1.5 → floor/ceil
  assert.equal(sell[9], Math.ceil(1017 * 1.015));
});
T("ladder refuses zero mid", () => {
  const r = deriveLadder({ levels: 10, spacingBps: 15 }, 0);
  assert.equal(r.buy.length, 0); assert.match(r.reason, /refuse/);
});
T("day ledger counts and caps (32000)", () => {
  const tmp = path.join(os.tmpdir(), `hg-day-${Date.now()}.json`);
  const orig = path.join(process.cwd(), "grids", "state", "hypergrid-ops-day.json");
  const led0 = { day: "2000-01-01", ops: 31990, cap: 32000 };
  fs.writeFileSync(tmp, JSON.stringify(led0));
  // emulate: dayCapRemaining with stale day → fresh day resets
  assert.equal(dayCapRemaining({ day: new Date().toISOString().slice(0, 10), ops: 31990, cap: 32000 }), 10);
  assert.equal(dayCapRemaining({ day: "2000-01-01", ops: 31990, cap: 32000 }), 32000);
});
T("tick plan: cancel-stale-first then place within C3 room", () => {
  const pol = { tickMs: 3000, levels: 10, spacingBps: 15, ttlSec: 60, maxOpsPerTick: 24, opsDayCap: 32000 };
  const now = Date.now();
  const openOwn = [{ seq: 1, at: now - 120_000 }, { seq: 2, at: now - 10_000 }];
  const plan = planTick(pol, 1017, openOwn, 5, { day: new Date().toISOString().slice(0, 10), ops: 0, cap: 32000 });
  assert.equal(plan.ops.filter((o) => o.kind === "cancel").length, 1); // seq1 stale (120s > 60s ttl)
  assert.ok(plan.ops.filter((o) => o.kind === "order").length <= 24);
  assert.ok(["PLANNED", "NO-OP"].includes(plan.verdict));
});
T("day-cap exhausted → verdict DAY-CAP-EXHAUSTED", () => {
  const pol = { tickMs: 3000, levels: 10, spacingBps: 15, ttlSec: 60, maxOpsPerTick: 24, opsDayCap: 32000 };
  const plan = planTick(pol, 1017, [], 5, { day: new Date().toISOString().slice(0, 10), ops: 32000, cap: 32000 });
  assert.equal(plan.verdict, "DAY-CAP-EXHAUSTED"); assert.equal(plan.budget, 0);
});
T("receipt row carries stable schema", () => {
  const row = JSON.parse(receiptRow({ kind: "measure", verdict: "test" }));
  assert.equal(row.schema, RECEIPT_SCHEMA); assert.equal(row.kind, "measure"); assert.ok(row.at);
});

console.log(`[hypergrid-selftest] ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
