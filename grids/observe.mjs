// OBSERVE — צופה-מילויים-אמת (A-9 · fleet/r130): שרשרת → רשת-הטריגרים
// ═══════════════════════════════════════════════════════════════════════════
// החוליה-שנפלה: mover מבצע 16-tx חיים, coin-raffle חוצה את הספר — והמדידה
// הפנימית נשארת realFills:0. צופה-זה סוגר את-הלולאה בחזרה: קורא את
// account_history (חסר-מפתחות לגמרי — קריאה-ציבורית), מחלץ fill_order
// שבהם headcorner צד-אחד, ומזרים אותם כאירועי grid.fill עם real:true
// ליומן-הרשת ולמד-המדינה. אמת מוטבעת-על-שרשרת בלבד — אין-המצאה.
//
// דוקטרינה:
//   · קריאה-בלבד. אפס-חתימה, אפס-מפתחות, אפס-כתיבה-לשרשרת.
//   · דדופ לפי seq של יומן-ההיסטוריה (מונוטוני) — אף-מילוי לא נספר-פעמיים.
//   · כישלון-רשת = המשך-שקט (הגרידים לא נפגעים); אמת שלא-נמדדה לא-נספרת.
//   · צד-נגזר: current_owner/open_owner קובע מי-שילם-מה (NAI 21=STEEM 13=SBD).

const NAI = { STEEM: "@@000000021", SBD: "@@000000013", VESTS: "@@000000037" };
const NAI_NAME = Object.fromEntries(Object.entries(NAI).map(([k, v]) => [v, k]));
const STEEM_NODES = ["https://steemapi.boylikegirl.club", "https://api.justyy.com", "https://api.steemit.com"];

export const ACCOUNT = process.env.SAOS_RELAY_AGENT_ACCOUNT || "headcorner";

const amt = (a) => ({
  value: parseInt(a.amount, 10) / 10 ** a.precision,
  sym: NAI_NAME[a.nai] ?? a.nai,
});

/* ── טהור: מערך-היסטוריה → מילויים (נבדק אופליין ב-observe-selftest) ────── */
export function parseFills(history, account, sinceSeq = -1) {
  const fills = [];
  let lastSeq = sinceSeq;
  for (const item of history ?? []) {
    const [seq, x] = item;
    if (seq <= sinceSeq) continue;
    lastSeq = Math.max(lastSeq, seq);
    const op = x?.op ?? {};
    if (op.type !== "fill_order_operation") continue;
    const v = op.value ?? {};
    const isCurrent = v.current_owner === account;
    const isOpen = v.open_owner === account;
    if (!isCurrent && !isOpen) continue;
    const cur = amt(v.current_pays);
    const opn = amt(v.open_pays);
    // אנחנו current_owner: שילמנו current_pays. אנחנו open_owner: שילמנו open_pays.
    const mine = isCurrent ? cur : opn;
    const theirs = isCurrent ? opn : cur;
    const counterparty = isCurrent ? v.open_owner : v.current_owner;
    let side, steem, sbd;
    if (mine.sym === "STEEM" && theirs.sym === "SBD") {
      side = "ask"; steem = mine.value; sbd = theirs.value; // מכרנו STEEM
    } else if (mine.sym === "SBD" && theirs.sym === "STEEM") {
      side = "bid"; steem = theirs.value; sbd = mine.value; // קנינו STEEM
    } else continue; // זוג-לא-צפוי — לא נמצא בספר STEEM:SBD, מדלגים כנה
    fills.push({
      seq,
      at: x.timestamp,
      side,
      steem: Math.round(steem * 1e6) / 1e6,
      sbd: Math.round(sbd * 1e6) / 1e6,
      rate: Math.round((sbd / steem) * 1e7) / 1e7,
      counterparty,
    });
  }
  fills.sort((a, b) => a.seq - b.seq);
  return { fills, lastSeq };
}

/* ── רשת: קריאת account_history חסרת-מפתחות עם סולם-RPC ─────────────────── */
async function rpcCall(method, params) {
  let lastErr;
  for (const node of STEEM_NODES) {
    for (const m of [method, method.replace("account_history_api", "condenser_api")]) {
      // שני-שמות-המתודה: ה-breaker של jussi פועל-פר-נתיב — condenser לפעמים פתוח-כש-plugin סגור
      const p = m.startsWith("condenser_api") ? (params.account ? [params.account, params.start, params.limit] : params) : params;
      try {
        const r = await fetch(node, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: m, params: p, id: 1 }),
          signal: AbortSignal.timeout(12000),
        });
        if (!r.ok) throw new Error(`http ${r.status}`);
        const d = await r.json();
        if (d.error) throw new Error(d.error.data?.details?.slice(0, 80) ?? d.error.message?.slice(0, 100) ?? "rpc error");
        return normalizeHistory(d.result, m);
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr ?? new Error("all-rpc-nodes-failed");
}

/* condenser מחזיר [[seq, op]…] ישירות; account_history_api מחזיר {history} — מאחדים */
function normalizeHistory(result, method) {
  if (Array.isArray(result)) return { history: result };
  return result ?? { history: [] };
}

export async function observeRealFills({ account = ACCOUNT, limit = 200, sinceSeq = -1 } = {}) {
  const result = await rpcCall("account_history_api.get_account_history", { account, start: -1, limit });
  const history = result?.history ?? [];
  return parseFills(history, account, sinceSeq);
}

/* ── מד-רווחיות-אמת (A-10 · T-6): יסוד-עלות FIFO-ממוצע על מילויים-אמת ────────
   כנות-חשבונאית: רווח-ממומש נספר רק מול יסוד-עלות-נמדד (קניות-ביד בחלון).
   מכירה בלי-יסוד (מלאי-שנרכש-קודם-החלון) נרשמת unbased — נזילה-נמדדת,
   אבל לא נטענת כרווח. אפס-המצאה. */
export const emptyPnl = () => ({
  buys: 0, sells: 0,
  boughtSteem: 0, spentSbd: 0,
  soldSteem: 0, proceedsSbd: 0,
  realizedSbd: 0,
  unbasedSteem: 0, unbasedSbd: 0,
  positionSteem: 0, positionCostSbd: 0,
});

const r6 = (v) => Math.round(v * 1e6) / 1e6;

/** צעד-טהור-אחד: מדינת-pnl + מילוי → מדינת-pnl חדשה (לסירוגין בסדר-seq). */
export function applyPnlFill(pnl, fill) {
  const p = { ...pnl };
  if (fill.side === "bid") {
    p.buys += 1;
    p.boughtSteem = r6(p.boughtSteem + fill.steem);
    p.spentSbd = r6(p.spentSbd + fill.sbd);
    p.positionSteem = r6(p.positionSteem + fill.steem);
    p.positionCostSbd = r6(p.positionCostSbd + fill.sbd);
  } else {
    p.sells += 1;
    p.soldSteem = r6(p.soldSteem + fill.steem);
    p.proceedsSbd = r6(p.proceedsSbd + fill.sbd);
    const pos = p.positionSteem, cost = p.positionCostSbd;
    if (pos > 1e-9) {
      const based = Math.min(fill.steem, pos);
      const avg = cost / pos; // יסוד-עלות-ממוצע
      p.realizedSbd = r6(p.realizedSbd + fill.sbd * (based / fill.steem) - avg * based);
      const rest = r6(fill.steem - based);
      p.positionSteem = r6(pos - based);
      p.positionCostSbd = r6(cost - avg * based);
      if (rest > 1e-9) { p.unbasedSteem = r6(p.unbasedSteem + rest); p.unbasedSbd = r6(p.unbasedSbd + fill.sbd * (rest / fill.steem)); }
    } else {
      p.unbasedSteem = r6(p.unbasedSteem + fill.steem);
      p.unbasedSbd = r6(p.unbasedSbd + fill.sbd);
    }
  }
  return p;
}

/** חבילה: מילויים (בסדר-seq) → מד-רווחיות מלא. */
export function realizedPnl(fills) {
  let p = emptyPnl();
  for (const f of [...fills].sort((a, b) => a.seq - b.seq)) p = applyPnlFill(p, f);
  p.openAvgCost = p.positionSteem > 1e-9 ? r6(p.positionCostSbd / p.positionSteem) : null;
  return p;
}

/* ── מיזוג למדינה: מעדכן feeMeter + מחזיר אירועי grid.fill אמת ───────────── */
export function applyRealFills(state, { fills, lastSeq }) {
  if (!fills.length) return { newEvents: [], added: 0 };
  state.feeMeter = state.feeMeter ?? {};
  let sbdDelta = 0;
  const newEvents = fills.map((f) => {
    if (f.side === "ask") sbdDelta += f.sbd;
    else sbdDelta -= f.sbd;
    return {
      type: "grid.fill",
      source: "chain",
      real: true,
      payload: {
        side: f.side, steem: f.steem, sbd: f.sbd, rate: f.rate,
        counterparty: f.counterparty, at: f.at,
      },
    };
  });
  state.feeMeter.realFills = (state.feeMeter.realFills ?? 0) + fills.length;
  state.feeMeter.realSbdDelta = Math.round(((state.feeMeter.realSbdDelta ?? 0) + sbdDelta) * 1e6) / 1e6;
  state.feeMeter._lastRealSeq = lastSeq;
  /* A-10: מד-הרווחיות מתקדם מילוי-אחר-מילוי על-גבי-המדינה-הקיימת (סדר-seq) */
  let pnl = { ...(state.feeMeter.realPnl ?? emptyPnl()) };
  for (const f of fills) pnl = applyPnlFill(pnl, f);
  pnl.openAvgCost = pnl.positionSteem > 1e-9 ? Math.round((pnl.positionCostSbd / pnl.positionSteem) * 1e6) / 1e6 : null;
  state.feeMeter.realPnl = pnl;
  return { newEvents, added: fills.length };
}
