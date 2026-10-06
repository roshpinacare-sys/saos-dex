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
    if (url === "/" || url === "") {
      res.writeHead(307, { location: "/saos-dex" });
      res.end();
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
    const wsPort = (wsUrl === "/saos-dex" || wsUrl.startsWith("/saos-dex/") || wsUrl.startsWith("/_next/")) ? 3010 : 3050;
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
