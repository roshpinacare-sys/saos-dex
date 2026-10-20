/* ═══════════════════════════════════════════════════════════════════════════
 * PREVIEW-BRIDGE — גשר-התצוגה של הסנדבוקס (2026-10-06)
 * ═══════════════════════════════════════════════════════════════════════════
 * הבעיה שנמדדה: שרת-האם של הסנדבוקס (פורט 3000 — רק-redirect ל-/saos-dex)
* מנוגב שוב-ושוב על-ידי מנגנון-הסשן של הפלטפורמה (SIGKILL כל-דקות-ספורות,
* בלי-קשר לזיכרון/סשן — מדוד 4 סבבים), בעוד תהליך ה-DEX החי (3010) שרד
* שעות. ה-Preview של המפעיל נכנס דרך ה-gateway אל 3000 — ולכן ראה 502.
 *
 * הפתרון: הקשרה נוספת על אותו תהליך-חי — שרת-HTTP קטן על 127.0.0.1:3000
 * שעושה בדיוק את מה ששרת-האם עשה:
 *   · /           → 307 ל-/saos-dex
 *   · כל-השאר     → proxy תמים אל 127.0.0.1:3010 (אותו תהליך!)
 *
 * גבולות-חוק:
 *   · fail-closed: כל-כשל = דילוג-כנה, אפס-השפעה על השרשרת ועל ה-DEX.
 *   · אם פורט 3000 תפוס (שרת-האם האמיתי חי) — ההקשרה נכשלת ומושתקת;
 *     האם האמיתית מנצחת, הגשר מוותר. אין-תחרות.
 *   · מתג-כיבוי: הקובץ db/preview-bridge.off גורם לשחרור הפורט בבקשה-הבאה.
 *   · קשירה ל-127.0.0.1 בלבד — רק ה-gateway המקומי מדבר איתו.
 *   · v2: hop-by-hop headers מוסרים בשני-הכיוונים (framing-שבור נמדד ותוקן).
 * ═══════════════════════════════════════════════════════════════════════ */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";

const OFF_FILE = path.join(process.cwd(), "db", "preview-bridge.off");
const FLEET_OFF_FILE = path.join(process.cwd(), "db", "fleet-guard.off");

const g = globalThis as unknown as {
  __saosDexPreviewBridge?: http.Server;
  __saosDexFleetGuard?: NodeJS.Timeout;
};

/* ── FLEET-GUARD — חוק-הצי ברמת-הסנדבוקס (אדפטציה של fleet-guard r143-c) ──
 * מנגנון-הסשן של הפלטפורמה גוזר תהליכים שנולדו-מהסשן הנוכחי של הסוכן
 * (מדוד: SIGKILL תוך-דקות, 4 סבבים) — אך תהליכי-בן של תהליך-ה-DEX החי
 * נולדים-לסשן-הישן (6683) ויורשים את שרידותו. השומר הזה מקים כל מכונה
 * שנמצאת-מתה (בדיקת-פורט), כל-60 שניות, בתור-ילד של התהליך-החי.
 * מתג-כיבוי: db/fleet-guard.off · צי-הליבה = 9 מכונות מפת-האמת. */
const FLEET_CORE: Array<[string, number]> = [
  ["money", 3034], ["fleet-verify", 3038], ["curation", 3040],
  ["kpi", 3041], ["governance", 3042], ["treasury-audit", 3043],
  ["scout-market", 3044], ["business", 3045], ["content-factory", 3046],
  ["web", 3050], // T-47: קונסולת-האם (חוזה-הדלת-הקדמית · / → 3050) — נכנסת-לתוקף-בהפעלה-הבאה-של-הדקס
];
const FLEET_ROOT = "/home/z/my-project/zip";
const BUN = "/usr/local/bin/bun";

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 2500 }, (r) => {
      r.resume();
      resolve(true);
    });
    req.on("timeout", () => { req.destroy(); resolve(true); }); // מגיב-לאט = חי
    req.on("error", () => resolve(false));
  });
}

function startFleetGuard(): void {
  const tick = async (): Promise<void> => {
    try {
      if (fs.existsSync(FLEET_OFF_FILE)) return; // המתג סגור — שומרים בלי-פעולה
      for (const [name, port] of FLEET_CORE) {
        if (await probePort(port)) continue;
        const child = spawn(BUN, [path.join(FLEET_ROOT, "mini-services", name, "index.ts")], {
          cwd: FLEET_ROOT,
          detached: false, // ילד של התהליך-החי — יורש-סשן, לא-סשן-חדש
          stdio: "ignore",
        });
        child.on("error", () => { /* הקמה נכשלה — המחזור הבא ינסה שוב */ });
      }
    } catch { /* כשל-שומר = אפס-השפעה על השרשרת */ }
  };
  void tick();
  g.__saosDexFleetGuard = setInterval(tick, 60_000);
}

function startBridge(): void {
  // FIX(hop-by-hop): כותרות-קפיצה-אחת אסור שיעברו בין-פרוקסי — העברה שלהן
  // משבשת את ה-framing של node (ה-body "לא-נגמר" מנקודת-מבט הלקוח — נמדד).
  const HOP = new Set(["transfer-encoding", "connection", "keep-alive", "upgrade", "proxy-authenticate", "proxy-authorization", "te", "trailer"]);
  const strip = (h: http.IncomingHttpHeaders | Record<string, unknown>): Record<string, string | string[]> => {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(h)) if (!HOP.has(k.toLowerCase()) && v != null) out[k] = Array.isArray(v) ? v.map(String) : String(v);
    return out;
  };
  const server = http.createServer((req, res) => {
    // מתג-כיבוי — נבדק פר-בקשה, אפס-מצב-ריצה
    try {
      if (fs.existsSync(OFF_FILE)) {
        // FIX(restart): close() ממתין לחיבורים-פתוחים (long-poll לעולם לא-נסגר לבד)
        // — closeAllConnections משחרר את הפורט מיד לשרת-הבא בתור
        try { g.__saosDexPreviewBridge?.closeAllConnections(); } catch { /* ישן מדי */ }
        g.__saosDexPreviewBridge?.close();
        g.__saosDexPreviewBridge = undefined;
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end("preview-bridge: off");
        return;
      }
    } catch { /* קריאת-מתג נכשלה — ממשיכים תקין */ }

    const url = req.url ?? "/";
    /* PEACE TREATY (2026-10-07 · mother-console restoration · operator-ruled
     * "עשה שלום, לא מלחמה"): the front door "/" now falls through to the
     * edge-router below — it lands on the REAL mother console (:3050, kept
     * alive by /api/revive → zip/mini-services/web supervisor, container-boot
     * lineage). The DEX terminal remains the first-class deep link at
     * /saos-dex, and /api/health stays local (keeper peace).
     * (was: "/" → 307 /saos-dex — the operator ruled: "זה לא הדף".) */
    // FIX(task-10 · war-end): /api/health נענה כאן, מקומית — החוק-הנמדד:
    // dev-revive (keeper r190+) בודק 200 על :3000/api/health וכשהוא מקבל
    // 404 הוא הורג את מחזיק-הפורט (= ה-DEX החי!) ומקים dev שנשחט בעצמו —
    // מלחמת-הפורט-האינסופית (מדוד 4+ סבבים). מענה 200 כנה מכאן = האמא-האמיתית
    // "חיה" בעיני-החוק, אין-קטל, אין-תחרות. הכנות: שני-המעלים נבדקים חי.
    if (url === "/api/health") {
      const probe = (port: number, path: string) =>
        new Promise<string>((resolve) => {
          const rq = http.get({ host: "127.0.0.1", port, path, timeout: 2500 }, (r) => {
            r.resume();
            resolve(r.statusCode === 200 ? "UP" : `HTTP ${r.statusCode ?? "?"}`);
          });
          rq.on("timeout", () => { rq.destroy(); resolve("SLOW"); });
          rq.on("error", () => resolve("DOWN"));
        });
      void Promise.all([probe(3010, "/saos-dex/api/dex/metrics"), probe(3050, "/")])
        .then(([dex, consoleUp]) => {
          if (res.headersSent) return;
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({
            ok: true,
            service: "preview-bridge",
            port: 3000,
            doctrine: "edge-router (Task 7/10): /saos-dex→3010 · rest→3050 · health-local",
            upstreams: { dex3010: dex, console3050: consoleUp },
            at: new Date().toISOString(),
          }));
        })
        .catch(() => {
          try {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true, service: "preview-bridge", degraded: true }));
          } catch { /* לקוח נטש */ }
        });
      return;
    }
    // ═══ נתב-קצה: /saos-dex* → ה-DEX החי (3010, אותו תהליך) · כל-השאר →
    // קונסולת-ה-WEAVE (3050, ילדת-ה-DEX). מנועי-הבית (publish/charter/health/
    // gate/כספת) חיים-מאחורי-אותו-origin — הצי מדבר-אל-3000 ומגיע-הביתה.
    const isDex = url === "/saos-dex" || url.startsWith("/saos-dex/");
    const edgePort = isDex ? 3010 : 3050;
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: edgePort,
        path: url,
        method: req.method,
        headers: { ...strip(req.headers), host: `127.0.0.1:${edgePort}` },
      },
      (up) => {
        const headers = strip(up.headers);
        res.writeHead(up.statusCode ?? 502, headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`preview-bridge: edge unreachable (${(e as NodeJS.ErrnoException)?.code ?? String(e)})`);
    });
    // FIX(lifecycle): נטישת-לקוח (abort של long-poll) = destroy ל-upstream.
    // לא על req 'close' (נורה מיד אחרי-הכותרות ב-GET — ECONNRESET נמדד) אלא
    // על res 'close' עם writableEnded=false — רק-נטישה אמת, לא סיום-בקשה.
    res.on("close", () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  });
  server.on("error", () => {
    // פורט תפוס (האם האמיתית חיה) או כשל-הקשרה — הגשר מוותר בכנות, אפס-רעש
    g.__saosDexPreviewBridge = undefined;
  });
  // FIX(hmr-ws): HMR של dev דורש WebSocket — tunnel גולמי ל-3010 (ה-gateway
  // מקדימה את ה-upgrade; בלי-זה ההידרציה של dev נשארת מושהית — נמדד).
  server.on("upgrade", (req, clientSocket, head) => {
    // מנהרה-לפי-נתיב: HMR של ה-DEX — כולל נתיב-השורש /_next/* (Next-dev משרת
    // את socket-ה-HMR בשורש גם עם basePath — נמדד: ניתוב-שורש→3050 עצר הידרציה)
    // → 3010 · רק-WS-זר-אמת → 3050.
    const wsUrl = req.url ?? "/";
    // T-95·gal-94 (MEASURE): console HMR was starved — every /_next/* WS went to
    // 3010, so the mother console (3050) hydrated never (full SSR shell, dead
    // effects, no errors — reproduced 4 rounds). Discriminator (measured live):
    // the Referer of the WS handshake is the page that spawned it.
    const ref = String(req.headers.referer ?? req.headers.origin ?? "");
    const fromConsole = ref !== "" && !ref.includes("/saos-dex");
    const wsPort = fromConsole ? 3050 : (wsUrl === "/saos-dex" || wsUrl.startsWith("/saos-dex/") || wsUrl.startsWith("/_next/")) ? 3010 : 3050;
    try { fs.appendFileSync(path.join(process.cwd(), "db", "ws-route.log"), JSON.stringify({ at: new Date().toISOString(), url: wsUrl, ref, fromConsole, port: wsPort }) + "\n"); } catch { /* honest */ }
    const upstreamSocket = net.connect(wsPort, "127.0.0.1", () => {
      const lines: string[] = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        const v = req.rawHeaders[i + 1];
        lines.push(k.toLowerCase() === "host" ? `Host: 127.0.0.1:${wsPort}` : `${k}: ${v}`);
      }
      upstreamSocket.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) upstreamSocket.write(head);
    });
    clientSocket.on("error", () => upstreamSocket.destroy());
    upstreamSocket.on("error", () => clientSocket.destroy());
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
  });
  server.listen(3000, "127.0.0.1");
  g.__saosDexPreviewBridge = server;
}

/* נקודת-הפעלה דטרמיניסטית — נקראת מתוך ה-handler (רץ פר-בקשה) כי Turbopack
 * אינו מריץ side-effects של מודולי-שרת מחדש (נמדד). המתגיים ב-globalThis
 * מבטיחים הקשרה-יחידה; כל-כשל = דילוג-כנה, אפס-השפעה על השרשרת. */
export function ensurePreviewBridge(): void {
  if (!g.__saosDexPreviewBridge) {
    try {
      startBridge();
    } catch {
      // אפס-השפעה על ה-DEX — הגשר הוא ניחומים, לא שער
    }
  }
  if (!g.__saosDexFleetGuard) {
    try {
      startFleetGuard();
    } catch {
      // אפס-השפעה על ה-DEX — השומר הוא ניחומים, לא שער
    }
  }
}
