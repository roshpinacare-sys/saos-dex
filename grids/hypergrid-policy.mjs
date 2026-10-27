#!/usr/bin/env node
/* SAOS-DEX · HYPERGRID-POLICY/1 — G78-b-R1 (Task ID G78-b-R1, wave G78 rescue batch 1)
 * Owner-checked loader for the ARMED hyperGrid policy (exec-armed.json) + ops-cap ledger.
 *
 * Root causes measured 2026-10-27 (wave G78-b-R1):
 *  1. exec-armed.json hyperGrid section had ZERO consumers in the fleet (grep-proven:
 *     saos-dex + giant mini-services) — the armed caps were dead letters; the live
 *     book ran legacy rails only (soldiers ×2 ±20bps, arena ladder 8, treasury 2).
 *  2. hft-loop :3049 boots observe-mode (no DEX_OPERATOR_TOKEN in its env) — measured
 *     from its own /health — so the tick engine cannot sign real ops.
 *  3. C3 brake (kernel mandate.positions.maxOpenPositions — per-issuer in-flight
 *     velocity) saturates after ~5 concurrent operator orders: a naive 20-op ladder
 *     measured 4 queued / 16 risk:C3. Grid must cancel its own stale legs BEFORE
 *     placing (ttlSec discipline) — this module encodes that order of operations.
 *
 * Laws here: zero mocks · fail-closed on missing/foreign policy · allowTransfersOut
 * must be literally false (HARD GUARD) · ops counted against maxOpsPerTick and
 * opsDayCap with a persisted day-ledger · receipts in the stable SAOS-*-RECEIPT/1
 * jsonl format this repo already exports (see grids/state/*-receipts.jsonl).
 */
import fs from "node:fs";
import path from "node:path";

export const RECEIPT_SCHEMA = "SAOS-HYPERGRID-RECEIPT/1";
const DEFAULT_SECRETS_DIR = "/home/z/coord-work/vaults/steem-secrets";
const DAY_LEDGER = path.join(process.cwd(), "grids", "state", "hypergrid-ops-day.json");

/** Load + validate the armed policy. Returns {ok:false, reason} fail-closed. */
export function loadHyperGridPolicy(secretsDir = process.env.STEEM_SECRETS_DIR || DEFAULT_SECRETS_DIR) {
  const file = path.join(secretsDir, "exec-armed.json");
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { ok: false, reason: `policy unreadable (${e.code ?? e.message}) — fail-closed` };
  }
  if (raw.armed !== true) return { ok: false, reason: "policy armed!==true — fail-closed" };
  const hg = raw.hyperGrid;
  if (!hg || typeof hg !== "object") return { ok: false, reason: "hyperGrid section missing — fail-closed" };
  if (hg.enabled !== true) return { ok: false, reason: "hyperGrid.enabled!==true — fail-closed" };
  // HARD GUARD (owner law): the policy must not authorize outbound transfers.
  if (raw.policy && raw.policy.allowTransfersOut !== false) {
    return { ok: false, reason: "allowTransfersOut!==false — HARD GUARD refusal" };
  }
  const need = ["tickMs", "levels", "spacingBps", "ttlSec", "maxOpsPerTick", "opsDayCap"];
  for (const k of need) if (typeof hg[k] !== "number" || !(hg[k] > 0)) return { ok: false, reason: `hyperGrid.${k} not a positive number — fail-closed` };
  // Never echo secrets: only the numeric policy leaves this function.
  return {
    ok: true,
    policy: {
      tickMs: hg.tickMs, levels: hg.levels, spacingBps: hg.spacingBps, ttlSec: hg.ttlSec,
      orderTtlSec: hg.orderTtlSec ?? null, askBudgetPct: hg.askBudgetPct ?? null,
      minRcPct: hg.minRcPct ?? null, burst: hg.burst ?? null,
      maxOpsPerTick: hg.maxOpsPerTick, opsDayCap: hg.opsDayCap, chainTailSec: hg.chainTailSec ?? null,
      allowTransfersOut: raw.policy?.allowTransfersOut === false ? false : null,
      source: file,
    },
  };
}

/** Persisted per-day ops ledger (UTC day key). Counts every attempt, queued or refused. */
export function opsDayLedger(now = Date.now(), dayCap) {
  const day = new Date(now).toISOString().slice(0, 10);
  let led = { day, ops: 0 };
  try {
    const j = JSON.parse(fs.readFileSync(DAY_LEDGER, "utf8"));
    if (j.day === day) led = j;
  } catch { /* first run today — fresh ledger, not an error */ }
  return { ...led, cap: dayCap ?? null };
}

export function recordOps(led, n, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const next = { day: led.day === day ? led.day : day, ops: (led.day === day ? led.ops : 0) + n, cap: led.cap ?? null };
  fs.mkdirSync(path.dirname(DAY_LEDGER), { recursive: true });
  fs.writeFileSync(DAY_LEDGER, JSON.stringify(next));
  return next;
}

export function dayCapRemaining(led) {
  if (!led.cap) return null;
  return Math.max(0, led.cap - (led.day === new Date().toISOString().slice(0, 10) ? led.ops : 0));
}

/** Derive the ladder: `levels` per side around `mid`, `spacingBps` apart.
 * Returns {buy[],sell[]} price levels, nearest first. No IO — pure math. */
export function deriveLadder(policy, mid) {
  if (!(mid > 0)) return { buy: [], sell: [], reason: "no measured mid — refuse to mark" };
  const buy = [], sell = [];
  for (let i = 1; i <= policy.levels; i++) {
    buy.push(Math.floor(mid * (1 - policy.spacingBps * i / 10_000)));
    sell.push(Math.ceil(mid * (1 + policy.spacingBps * i / 10_000)));
  }
  return { buy, sell };
}

/** C3-aware tick plan: cancel-own-stale FIRST, then place only within the
 * remaining in-flight budget (measured: kernel C3 saturates per-issuer).
 * `openOwn` = our live orders now; `inFlightCap` = measured max open per issuer. */
export function planTick(policy, mid, openOwn, inFlightCap, dayLed) {
  const ops = [];
  const remainDay = dayCapRemaining(dayLed);
  let budget = Math.min(policy.maxOpsPerTick, remainDay ?? policy.maxOpsPerTick);
  if (budget <= 0) return { ops, verdict: "DAY-CAP-EXHAUSTED", budget: 0 };
  for (const o of openOwn) {
    if (budget <= 0) break;
    const ageMs = Date.now() - o.at;
    if (ageMs > policy.ttlSec * 1000) { ops.push({ kind: "cancel", seq: o.seq, ageMs }); budget--; }
  }
  const ladder = deriveLadder(policy, mid);
  const liveAfterCancels = openOwn.filter((o) => Date.now() - o.at <= policy.ttlSec * 1000).length;
  const room = Math.max(0, (inFlightCap ?? policy.maxOpsPerTick) - liveAfterCancels - ops.filter((o) => o.kind === "cancel").length * 0);
  let place = Math.min(ladder.buy.length + ladder.sell.length, room, budget);
  const out = [...ops];
  let b = 0, s = 0;
  for (let i = 0; i < place; i++) {
    const side = i % 2 === 0 ? "buy" : "sell";
    if (side === "buy" && b < ladder.buy.length) { out.push({ kind: "order", side, level: b + 1, price: ladder.buy[b++] }); budget--; }
    else if (side === "sell" && s < ladder.sell.length) { out.push({ kind: "order", side, level: s + 1, price: ladder.sell[s++] }); budget--; }
  }
  const verdict = out.length === 0 ? "NO-OP" : "PLANNED";
  return { ops: out, verdict, budget, dayRemaining: remainDay };
}

/** Stable-format receipt row (SAOS-HYPERGRID-RECEIPT/1) — append-only jsonl. */
export function receiptRow(fields) {
  return JSON.stringify({ schema: RECEIPT_SCHEMA, at: new Date().toISOString(), ...fields });
}
