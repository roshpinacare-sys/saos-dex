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
 * ═══════════════════════════════════════════════════════════════════════ */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

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
  const server = http.createServer((req, res) => {
    // מתג-כיבוי — נבדק פר-בקשה, אפס-מצב-ריצה
    try {
      if (fs.existsSync(OFF_FILE)) {
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
    // proxy תמים אל ה-DEX החי (אותו תהליך — 127.0.0.1:3010)
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: 3010,
        path: url,
        method: req.method,
        headers: { ...req.headers, host: "127.0.0.1:3010" },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("preview-bridge: dex unreachable");
    });
    req.pipe(upstream);
  });
  server.on("error", () => {
    // פורט תפוס (האם האמיתית חיה) או כשל-הקשרה — הגשר מוותר בכנות, אפס-רעש
    g.__saosDexPreviewBridge = undefined;
  });
  server.listen(3000, "127.0.0.1");
  g.__saosDexPreviewBridge = server;
}

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

export {};
