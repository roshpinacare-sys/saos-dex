/**
 * fixedfloat.ts — FixedFloat (ff.io) external-swap provider client · READ-ONLY.
 * (directive §4 foundation, task E12 — the bridge must know the outside price
 * of assets we can route through an external swap provider.)
 *
 * Wire contract measured live 2026-10-26 (E12, zero fabrication — probed, then
 * read from https://ff.io/en/api): the legacy fixedfloat.com/api/v1 host now
 * 301-redirects to ff.io and /api/v1 paths 404 there; the live API is v2:
 *   · POST https://ff.io/api/v2/ccies — no params (sign of empty body)
 *   · POST https://ff.io/api/v2/price — JSON body
 *       {fromCcy,toCcy,amount,direction:"from"|"to",type:"fixed"|"float"}
 *   · headers: X-API-KEY + X-API-SIGN; Content-Type: application/json;charset=UTF-8
 *   · X-API-SIGN = hex(HMAC-SHA256(secret, exact request-body string))
 *   · response envelope: {code:0, msg:"OK", data:…} — code!=0 / errors[] = honest fail
 *
 * Credentials: process.env FIXEDFLOAT_API_KEY / FIXEDFLOAT_API_SECRET first;
 * fallback: parse /home/z/.secrets-sovereign/fixedfloat.env (same fs-read pattern
 * the dex-beat-service uses for .sovereign-ops-token) because the :3010 dev
 * server predates these keys — env-only would turn every quote into an honest
 * 503 while the key material sits on disk. Secrets NEVER appear in thrown
 * error text or in any response payload.
 *
 * Read-only law: this client only calls ccies + price. Order creation
 * (/api/v2/create) is NOT wired here — that is a money-movement decision and
 * stays behind the operator gate in a future directive.
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const FF_BASE = "https://ff.io/api/v2";
const SECRETS_FILE = "/home/z/.secrets-sovereign/fixedfloat.env";
const UA = "saos-dex-bridge/1.0 (sovereign; +https://github.com/roshpinacare-sys/saos-dex)";

export type FixedFloatCcy = {
  code: string;
  coin: string;
  network: string;
  name: string;
  recv: number; // 1 = service can receive this coin
  send: number; // 1 = service can send this coin
  tag: string | null;
};

export type FixedFloatSide = {
  code: string;
  network: string;
  coin: string;
  amount: number;
  rate: number;
  precision: number;
  min: number;
  max: number;
  usd?: number;
  btc?: number;
};

export type FixedFloatRate = {
  type: string;
  from: FixedFloatSide;
  to: FixedFloatSide;
  errors: string[];
};

type FFEnvelope<T> = { code: number; msg: string; data: T };

let cachedCreds: { key: string; secret: string } | null = null;

function parseSecretsFile(): { key: string; secret: string } | null {
  try {
    const txt = readFileSync(SECRETS_FILE, "utf8");
    const get = (k: string): string => {
      const m = txt.match(new RegExp(`^\\s*${k}\\s*=\\s*(.+?)\\s*$`, "m"));
      return m ? m[1].trim() : "";
    };
    const key = get("FIXEDFLOAT_API_KEY");
    const secret = get("FIXEDFLOAT_API_SECRET");
    return key && secret ? { key, secret } : null;
  } catch {
    return null;
  }
}

function ffCreds(): { key: string; secret: string } {
  const envKey = process.env.FIXEDFLOAT_API_KEY ?? "";
  const envSecret = process.env.FIXEDFLOAT_API_SECRET ?? "";
  if (envKey && envSecret) return { key: envKey, secret: envSecret };
  if (!cachedCreds) cachedCreds = parseSecretsFile();
  if (!cachedCreds) {
    throw new Error(
      "fixedfloat: no credentials — set FIXEDFLOAT_API_KEY/FIXEDFLOAT_API_SECRET (env or " + SECRETS_FILE + ")"
    );
  }
  return cachedCreds;
}

/** One signed call to the FixedFloat v2 API. `body` is signed EXACTLY as sent. */
async function ffCall<T>(method: string, body: string): Promise<T> {
  const { key, secret } = ffCreds();
  const sign = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  let res: Response;
  try {
    res = await fetch(`${FF_BASE}/${method}`, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json; charset=UTF-8",
        "X-API-KEY": key,
        "X-API-SIGN": sign,
        "User-Agent": UA,
      },
      body, // empty string for ccies — signed as "" (measured live)
    });
  } catch (e) {
    throw new Error(`fixedfloat: network error on /${method}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`fixedfloat: auth rejected on /${method} (HTTP ${res.status})`);
  }
  if (res.status === 404) {
    throw new Error(`fixedfloat: /${method} not found (ff.io v2 wire contract drift?)`);
  }
  if (!res.ok) {
    throw new Error(`fixedfloat: HTTP ${res.status} on /${method}`);
  }
  const env = (await res.json().catch(() => null)) as FFEnvelope<T> | null;
  if (!env || typeof env.code !== "number") {
    throw new Error(`fixedfloat: unparseable envelope on /${method}`);
  }
  if (env.code !== 0) {
    throw new Error(`fixedfloat: /${method} error code=${env.code} msg=${env.msg}`);
  }
  return env.data;
}

/** GET-style: list of supported currencies (code, network, recv/send availability). */
export async function fixedfloatGetCurrencies(): Promise<FixedFloatCcy[]> {
  return ffCall<FixedFloatCcy[]>("ccies", "");
}

/**
 * Live rate for a pair. direction="from" with a nominal amount — the provider
 * returns rate (toCcy per 1 fromCcy) + min/max limits for that side.
 * FixedFloat codes are upper-case and may carry a network suffix (BTC, ETH,
 * USDTTRC, …); input is case-folded for caller convenience.
 */
export async function fixedfloatGetRate(
  from: string,
  to: string,
  opts?: { amount?: number; type?: "fixed" | "float" }
): Promise<FixedFloatRate> {
  const amount = opts?.amount && opts.amount > 0 ? opts.amount : 1;
  const type = opts?.type ?? "float";
  const body = JSON.stringify({
    fromCcy: from.toUpperCase(),
    toCcy: to.toUpperCase(),
    amount,
    direction: "from",
    type,
  });
  const data = await ffCall<FixedFloatRate>("price", body);
  if (!data || !data.from || !data.to || typeof data.from.rate !== "number") {
    throw new Error("fixedfloat: price response missing rate fields");
  }
  return data;
}
