#!/usr/bin/env node
// CURATE-NODE-HEALTH — שער-REDPROOF לצי-צמתי-הקיורציה (§71 · 2026-11-19)
// ═══════════════════════════════════════════════════════════════════════════
// השורש-המדוד: 12-ריצות-אדומות של curate מאז 18.11T14:46Z — כל-ניסיון מת על
// «fetch failed» כי 2-מתוך-5-הצמתים המוגדרים מתו (api.steem.buzz ·
// rpc.steemviz.com — כשל-חיבור), steem-rpc.publicnode.com מחזיר 404,
// והרוטציה-הייתה מגן-נייר. החוק החדש: הפעימה רשאית-לרוץ רק כש-3-צמתים-עצמאיים
// לפחות עונים על קריאת-condenser-אמיתית — והחוק הזה מדיד לפני-כל-שינוי
// (REDPROOF: רץ-אדום על-הרשימה-הישנה, ירוק על-המחודשת — fail-closed).
// שימוש: node grids/curate-node-health.mjs [--gate]   (gate: exit 1 אם alive<3)
// ═══════════════════════════════════════════════════════════════════════════
import { STEEM_NODES } from "./curate.mjs";

export async function probeNode(node, timeoutMs = 8000) {
  try {
    const r = await fetch(node, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "condenser_api.get_dynamic_global_properties", params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    if (!text || !text.trim()) return { node, ok: false, why: `http-${r.status} empty-body` };
    let j;
    try { j = JSON.parse(text); } catch { return { node, ok: false, why: `http-${r.status} non-json-body` }; }
    const blk = j?.result?.head_block_number;
    if (typeof blk !== "number") return { node, ok: false, why: `http-${r.status} no-dgpo` };
    return { node, ok: true, why: `block=${blk}` };
  } catch (e) {
    return { node, ok: false, why: String(e?.cause?.code ?? e?.message ?? e).slice(0, 60) };
  }
}

export async function probeFleet(nodes = STEEM_NODES) {
  return Promise.all(nodes.map((n) => probeNode(n)));
}

const argv = process.argv.slice(2);
if (argv.includes("--gate") || argv.includes("--selftest")) {
  const res = await probeFleet();
  for (const r of res) console.log(`[node-health] ${r.ok ? "ALIVE" : "DEAD "} ${r.node} — ${r.why}`);
  const alive = res.filter((r) => r.ok).length;
  console.log(`[node-health] alive=${alive}/${res.length} (חוק: נדרשים >=3)`);
  if (alive < 3) {
    console.error("[node-health] GATE-RED: צי-הצמתים מתחת-ל-3-חיים — פעימת-הקיורציה אסורה-לרוץ");
    process.exit(1);
  }
  console.log("[node-health] GATE-GREEN");
}
