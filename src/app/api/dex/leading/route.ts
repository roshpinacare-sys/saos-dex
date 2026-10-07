import { NextResponse } from "next/server";
import { getLiveState } from "@/lib/dex/chain";
import { chainStream, type ChainStreamRow } from "@/lib/dex/chain-stream";
import { doorReport } from "@/lib/dex/peg-door";
import { extFeeds } from "@/lib/dex/price-proof";
import { routableMap } from "@/lib/dex/router";
import { ASSETS, type Asset } from "@/lib/dex/kernel";

export const dynamic = "force-dynamic";

/* ══ EXEC-CD-13 · LEADING-COINS — רצועת-המטבעות-המובילים לעמוד-הראשי ════════
 * GET ציבורי (קריאה-בלבד) — הכל-מהמטמונים-החיים, אפס-RPC-נוסף:
 *   · מחירי-אמת ל-8 המטבעות-המובילים: זרם-הרשתות (חי) → פידי-חוץ (חציון-מקורות)
 *   · עוגנים: oracleMu · backingMu · פסק-הדלת (CONVERGED/DRIFT/DIVERGENT/NO-POOL)
 *   · נזילות-אמת: מפת-הראוטר-החיה פר-נכס (hub/deep/micro/rail/none)
 *   · יתרות-המפעיל החיות — לווידג'ט-הסוואפ
 * אפס-המצאה: מה-שלא-נמדד = null גלוי (דוקטרינת-הכנות). */

const COINS: { key: string; sym: string; name: string; native: string; wrap: Asset | null }[] = [
  { key: "btc", sym: "BTC", name: "Bitcoin", native: "", wrap: null }, // אין-עוגן-WBTC ברישום-הקבוע — מחיר-שוק בלבד (כנות)
  { key: "eth", sym: "ETH", name: "Ethereum", native: "ETH", wrap: "WETH" },
  { key: "sol", sym: "SOL", name: "Solana", native: "SOL", wrap: "WSOL" },
  { key: "bnb", sym: "BNB", name: "BNB Chain", native: "BNB", wrap: "WBNB" },
  { key: "trx", sym: "TRX", name: "TRON", native: "TRX", wrap: "WTRX" },
  { key: "steem", sym: "STEEM", name: "STEEM", native: "STEEM", wrap: "WSTEEM" },
  { key: "hive", sym: "HIVE", name: "Hive", native: "HIVE", wrap: "PHIVE" },
  { key: "blurt", sym: "BLURT", name: "Blurt", native: "BLURT", wrap: "WBLURT" },
];

export async function GET() {
  try {
    const st = getLiveState();
    const [stream, feeds, door] = await Promise.all([
      chainStream().catch(() => null),
      extFeeds().catch(() => null),
      doorReport(st).catch(() => null),
    ]);
    const routable = new Map(routableMap().map((r) => [r.asset, r]));

    const byNative = new Map<string, ChainStreamRow>();
    for (const c of stream?.chains ?? []) if (!byNative.has(c.native)) byNative.set(c.native, c);

    const coins = COINS.map((c) => {
      const ch = c.native ? byNative.get(c.native) : undefined;
      const feed = feeds?.usd?.[c.key as keyof NonNullable<typeof feeds>["usd"]] ?? null;
      const priceUsd = ch?.priceUsd ?? feed;
      const src = ch?.priceUsd != null
        ? `net:${ch.priceSrc ?? "?"}`
        : feed != null ? `feed:${feeds?.src?.[c.key as keyof NonNullable<typeof feeds>["src"]] ?? "median-cross-source"}` : null;
      const wrap = c.wrap;
      const rt = wrap ? routable.get(wrap) : undefined;
      const peg = wrap ? (door?.peg.find((p) => p.asset === wrap) ?? null) : null;
      return {
        key: c.key,
        sym: c.sym,
        name: c.name,
        network: ch?.name ?? c.name,
        priceUsd: priceUsd ?? null,
        src,
        netLive: ch ? ch.connected : null, // BTC: אין-רשת-בזרם → null כנה (לא-ירוק-מזויף)
        blockAgeSec: ch?.blockAgeSec ?? null,
        latencyMs: ch?.latencyMs ?? null,
        wrapAsset: wrap,
        wrapTier: wrap ? (rt?.tier ?? "none") : null,
        backingMu: peg?.backingMu ?? (wrap ? (st.backing[wrap] ?? 0) : null),
        oracleMu: peg?.oracleMu ?? (wrap ? (st.oracle?.[wrap]?.mu ?? null) : null),
        pegVerdict: peg?.verdict ?? null,
        poolKey: peg?.pool?.key ?? null,
        spreadBps: peg?.spreadBps ?? null,
      };
    });

    /* הנכסים לווידג'ט-הסוואפ — כל-הרישום-הקבוע (15) + יתרת-המפעיל-החיה */
    const opBal = st.balances["operator"] ?? {};
    const assets = ASSETS.map((a) => ({
      id: a,
      tier: a === "USDS" ? "hub" : (routable.get(a)?.tier ?? "none"),
      balanceMu: opBal[a] ?? 0,
      oracleMu: st.oracle?.[a]?.mu ?? null,
    }));

    return NextResponse.json({
      ok: true,
      at: new Date().toISOString(),
      coins,
      assets,
      networks: stream ? { connected: stream.summary.connected, total: stream.summary.total, priceStale: stream.summary.priceStale } : null,
      identities: door ? door.identities : null,
      honesty: "מחירי-אמת בלבד: זרם-הרשתות-החי + פידי-חוץ-חציוני + אורקל-קנוני. סוואפ מבוצע על בריכות-חיות בלבד — אין-בריכה = אין-ציטות-שווא; הדרך-לעוגן-חדש היא פקדה-אמת דרך הדלת.",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message.slice(0, 140) : "leading-failed" }, { status: 200 });
  }
}
