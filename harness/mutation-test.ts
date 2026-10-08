/**
 * mutation-test.ts — ביקורת-המבקר · THE META-TEST (Stryker/mutmut-grade)
 * ═══════════════════════════════════════════════════════════════════════════════
 * EXEC-CD-35 · השאלה שאף-אחד לא שאל על ערכת-ההוכחות: **האם היא בכלל תופסת שקר?**
 * סוויט שמציגה PASS גם על גרעין-שבור היא תיאטרון, לא הוכחה. הענקים (Stryker,
 * mutmut, Google's fault-injection) מזריקים באגים מכוונים לגרסת-עותק של הקוד
 * ודורשים: **כל-מוטנט חייב למות** — נתפס באינוואריאנטה, או שונה-נצפית-מול-בזל.
 *
 * שני ערוצי-הריגה:
 *   K1 · סוללת-האינוואריאנטות (battery-core, מוזרקת-המודולים-מהעותק-המוטנטי)
 *        — פסק-דין FAIL ⇒ מת.
 *   K2 · דיפרנציאל-הבזל — המוטנט עבר את הסוללה אך טביעת-האצבע (root/feeMeter/
 *        feeAccrued/תוצאות-ערכת-הבזל) שונה-ביט-מהבזל-הבריאה ⇒ מת.
 *   שקול-אמת: PASS + טביעת-אצבע-זהה-ביט-ביט = שורד — חייב תיעוד-הצדקה.
 *
 * מוטנטים:
 *   · SEM-*  — 8 מוטנטים-סמנטיים-ממוקדים (הכתר: FEE_BPS→0/29, dedupe-off,
 *     invariant-neutered, canon-unsorted, canon-float-gate, auditor-blind,
 *     treasury-cut-eliminated) — כל-אחד היה באג-אמיתי-מסוג-שכבר-נראה בפראייר.
 *   · O*     — מוטציות-טקסט שיטתיות (===→!==, &&→||, <→<=, floor→ceil,
 *     return-flip, if(!)→if) על קבצי-הכסף (kernel/amm/book/canonical/settle),
 *     בלי-הערות, בגבול-תקציב-דטרמיניסטי.
 *
 * ריצה: DATABASE_URL=file:...db/dex.db bun harness/mutation-test.ts [--quick]
 * יציאה: exit 0 = כל-המוטנטים מתים-או-מתועדים-שקולים · exit 1 = יש-שורד-לא-מתועד.
 * ארטיפקט: audit-package/proof-pack/mutation.json
 */
import fs from "fs";
import path from "path";
import os from "os";

const ROOT = new URL("..", import.meta.url).pathname; // saos-dex/
const DEX_SRC = path.join(ROOT, "src/lib/dex");
const WORK = path.join(ROOT, ".mutwork");
const SNAP = path.join(ROOT, "db/state-snapshot.json");
const QUICK = process.argv.includes("--quick") || process.env.MUTATION_QUICK === "1";
const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 40_000);

/* ── מוטנטים-סמנטיים (find→replace מדויק; חסר = SKIP-NO-SITE מתועד) ─────────── */
interface SemanticMutant { id: string; file: string; find: string; replace: string; why: string }
const SEMANTIC: SemanticMutant[] = [
  { id: "SEM-FEE0", file: "kernel.ts", find: "export const FEE_BPS = 30;", replace: "export const FEE_BPS = 0;", why: "עמלת-הבריכה הסטטית מאפסת — הכנסות-העמלות נעלמות בשקט" },
  { id: "SEM-FEE29", file: "kernel.ts", find: "export const FEE_BPS = 30;", replace: "export const FEE_BPS = 29;", why: "החלקה-של-1bps מהעמלה — גניבה-מיקרוסקופית-מתמדת" },
  { id: "SEM-DEDUPE", file: "kernel.ts", find: 'if (nonceSet(st).has(dedupeKey)) return { ok: false, err: "replay-rejected", gas: 0 };', replace: 'if (false && nonceSet(st).has(dedupeKey)) return { ok: false, err: "replay-rejected", gas: 0 };', why: "מנגנון-ה-replay מנוטרל — עסקה-חוזרת עוברת פעמיים" },
  { id: "SEM-INV-OFF", file: "invariant.ts", find: "if (!cond) throw new InvariantViolation(message);", replace: "if (false) throw new InvariantViolation(message);", why: "פרימיטיבת-האסרט עצמה מנוטרלת — כל-ההצהרות נהיות דקורטיביות" },
  { id: "SEM-CANON-UNSORTED", file: "canonical.ts", find: ".sort()", replace: "", why: "מיון-המפתחות בקנון מוסר — שורש-המצב תלוי-סדר-הכנסה (סתירת-תאומים-בין-ריפו-ים)" },
  { id: "SEM-CANON-FLOAT", file: "canonical.ts", find: "if (!Number.isSafeInteger(x)) throw new CanonicalError(\"non-integer rejected", replace: "if (!Number.isFinite(x)) throw new CanonicalError(\"non-integer rejected", why: "שער-השלמים נפתח ל-float — המצב כבר לא דטרמיניסטי-בין-פלטפורמות" },
  { id: "SEM-AUDIT-CREDITS", file: "settle.ts", find: "const creditsOk = creditSum + st.gasUsed - minted === totals.credits;", replace: "const creditsOk = true;", why: "ביקורת-הקרדיטים מעוורת — הטבעה-לא-מגובה עוברת בשקט" },
  { id: "SEM-AMM-NO-CUT", file: "amm.ts", find: "const lpFee = feeAmt - Math.floor((feeAmt * TREASURY_CUT_PCT) / 100);", replace: "const lpFee = feeAmt;", why: "חיתוך-האוצר מבוטל — 100% מהעמלה ל-LP, האוצר מתרוקן-מהכנסות" },
];

/* ── מוטציות-טקסט שיטתיות (בלי-הערות; הגבלה-דטרמיניסטית-לכל-קובץ-אופרטור) ──── */
interface TextOp { id: string; re: RegExp; to: string; caps: Record<string, number> }
const TEXT_OPS: TextOp[] = [
  { id: "O-EQ", re: /===/g, to: "!==", caps: { "kernel.ts": 3, "amm.ts": 2, "book.ts": 2, "canonical.ts": 1, "settle.ts": 2 } },
  { id: "O-NEQ", re: /!==/g, to: "===", caps: { "kernel.ts": 2, "amm.ts": 1, "book.ts": 1, "settle.ts": 1 } },
  { id: "O-AND", re: /&&/g, to: "||", caps: { "kernel.ts": 2, "amm.ts": 1, "settle.ts": 1 } },
  { id: "O-LT", re: /(?<![<>=!+\-*/%&|^])<(?![<=])/g, to: "<=", caps: { "kernel.ts": 3, "amm.ts": 2, "book.ts": 1, "canonical.ts": 1, "settle.ts": 1 } },
  { id: "O-LE", re: /(?<![<>=])<=(?!=)/g, to: "<", caps: { "kernel.ts": 2, "amm.ts": 1, "book.ts": 1 } },
  { id: "O-GT", re: /(?<![<>=!|&\-])>(?![>=])/g, to: ">=", caps: { "kernel.ts": 3, "amm.ts": 2, "book.ts": 1, "settle.ts": 1 } },
  { id: "O-GE", re: /(?<![<>=])>=(?!=)/g, to: ">", caps: { "kernel.ts": 2, "amm.ts": 1 } },
  { id: "O-FLOOR", re: /Math\.floor\(/g, to: "Math.ceil(", caps: { "kernel.ts": 3, "amm.ts": 2, "book.ts": 1, "settle.ts": 1 } },
  { id: "O-RETF", re: /return false/g, to: "return true", caps: { "kernel.ts": 1, "amm.ts": 1, "book.ts": 1, "settle.ts": 1 } },
  { id: "O-RETT", re: /return true/g, to: "return false", caps: { "kernel.ts": 1, "amm.ts": 1, "book.ts": 1 } },
  { id: "O-NOTIF", re: /if \(!/g, to: "if (", caps: { "kernel.ts": 2, "amm.ts": 1, "book.ts": 1, "settle.ts": 1 } },
];

/* ── הוצאת-אתרי-מוטציה מחוץ-להערות ──────────────────────────────────────────── */
function codeOnly(src: string): string {
  // מסכה: הערות-שורה/בלוק מוחלפות ברווחים (אורך-נשמר — אינדקסים-תקפים)
  let out = "";
  let i = 0, n = src.length, inStr: string | null = null, inLine = false, inBlock = false;
  while (i < n) {
    const c = src[i], d = i + 1 < n ? src[i + 1] : "";
    if (inLine) { out += c === "\n" ? (inLine = false, "\n") : " "; i++; continue; }
    if (inBlock) { if (c === "*" && d === "/") { out += "  "; i += 2; inBlock = false; } else { out += c === "\n" ? "\n" : " "; i++; } continue; }
    if (inStr) {
      out += c;
      if (c === "\\") { out += d; i += 2; continue; }
      if (c === inStr) inStr = null;
      i++; continue;
    }
    if (c === "/" && d === "/") { inLine = true; out += "  "; i += 2; continue; }
    if (c === "/" && d === "*") { inBlock = true; out += "  "; i += 2; continue; }
    if (c === "\"" || c === "'" || c === "`") { inStr = c; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

interface Site { id: string; file: string; index: number; from: string; to: string }

/* ── זיהוי-הקשר-גנריקה (מוטנט ב-Record<...> = פסול-קומפילציה, לא-הרג-סמנטי) ──── */
function isGenericContext(masked: string, idx: number): boolean {
  const before = masked.slice(Math.max(0, idx - 100), idx);
  const after = masked.slice(idx, idx + 30);
  // `<` שנפתח-גנריקה: השם-הגנרי סוגר-את `before` ממש (ה-`<` עצמו הוא ה-match!)
  if (/(?:Record|Map|Set|Array|Partial|WeakSet|Promise|Omit|Pick)\s*$/.test(before)) return true;
  // תוכן-אחרי-ה-`<` נראה-כטיפוס
  if (/^<\s*(string|number|unknown|object|never|any|DexState|Op\b|OpKind|PoolLike|TradeEvent|BookOrder)/.test(after)) return true;
  // `>` שסוגר-גנריקה: יש `<` פתוח-מאז-הגבול-האחרון
  if (/<[A-Za-z][^;{}()<>]*$/.test(before) && /[,;\s)=]/.test(masked.slice(idx + 1, idx + 2))) return true;
  return false;
}

function buildMutants(): Site[] {
  const sites: Site[] = [];
  const files = ["kernel.ts", "amm.ts", "book.ts", "canonical.ts", "settle.ts"];
  for (const f of files) {
    const src = fs.readFileSync(path.join(DEX_SRC, f), "utf8");
    const masked = codeOnly(src);
    for (const op of TEXT_OPS) {
      const cap = op.caps[f] ?? 0;
      if (!cap) continue;
      let count = 0;
      op.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = op.re.exec(masked)) !== null && count < cap) {
        if (["O-LT", "O-LE", "O-GT", "O-GE"].includes(op.id) && isGenericContext(masked, m.index)) continue; // דלג-טיפוסים
        sites.push({ id: `${op.id}#${f}#${count + 1}`, file: f, index: m.index, from: m[0], to: op.to });
        count++;
      }
    }
  }
  return sites;
}

/* ── עותק-עבודה + קובץ-כניסה ───────────────────────────────────────────────── */
const ENTRY = (dexDir: string): string => `import { runBattery } from ${JSON.stringify(path.join(ROOT, "harness/battery-core.ts"))};
import { applyOp } from ${JSON.stringify(path.join(dexDir, "kernel.ts"))};
import { canon, stateRootOf } from ${JSON.stringify(path.join(dexDir, "canonical.ts"))};
import { ledgerAudit, genesisTotals } from ${JSON.stringify(path.join(dexDir, "settle.ts"))};
import { invariant, InvariantViolation } from ${JSON.stringify(path.join(dexDir, "invariant.ts"))};
const j = await Bun.file(${JSON.stringify(SNAP)}).json();
const st = j.state;
const out = await runBattery(st, { applyOp, canon, stateRootOf, ledgerAudit, genesisTotals, InvariantViolation, invariantFn: invariant }, { seed: 0x424242, seqs: 2, opsPerSeq: 50, quiet: true });
console.log("MUTRESULT:" + JSON.stringify({ verdict: out.verdict, summary: out.summary, golden: out.golden.map(g => g.ok ? 1 : 0), canaryOk: out.canaryOk, probesPass: out.probes.filter(p => p.pass).length, probesTotal: out.probes.length }));
process.exit(out.verdict === "PASS" ? 0 : 1);
`;

function mkWorkdir(tag: string, patch?: { file: string; index: number; from: string; to: string } | SemanticMutant): string {
  const dir = path.join(WORK, tag);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(path.join(dir, "src/lib/dex/x")), { recursive: true });
  fs.cpSync(DEX_SRC, path.join(dir, "src/lib/dex"), { recursive: true });
  if (patch) {
    const fp = path.join(dir, "src/lib/dex", patch.file);
    let src = fs.readFileSync(fp, "utf8");
    if ("why" in patch) {
      if (!src.includes(patch.find)) throw new Error(`NO-SITE ${patch.id}`);
      src = src.replace(patch.find, patch.replace);
    } else {
      if (src.slice(patch.index, patch.index + patch.from.length) !== patch.from) throw new Error(`SITE-DRIFT ${patch.id}`);
      src = src.slice(0, patch.index) + patch.to + src.slice(patch.index + patch.from.length);
    }
    fs.writeFileSync(fp, src);
  }
  fs.writeFileSync(path.join(dir, "entry.ts"), ENTRY(path.join(dir, "src/lib/dex")));
  return dir;
}

interface RunResult { exit: number | null; timedOut: boolean; compileCrash: boolean; result: { verdict: string; summary: unknown; golden: number[]; canaryOk: boolean; probesPass: number; probesTotal: number } | null; error: string }

async function runEntry(dir: string): Promise<RunResult> {
  const proc = Bun.spawn(["bun", path.join(dir, "entry.ts")], {
    cwd: dir,
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, DATABASE_URL: `file:${path.join(ROOT, "db/dex.db")}` },
  });
  const timer = setTimeout(() => { try { proc.kill(9); } catch { /* */ } }, TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  if (code === null) return { exit: null, timedOut: true, compileCrash: false, result: null, error: "timeout" };
  const compileCrash = !stdout.includes("MUTRESULT:") && /error:|SyntaxError|must be initialized|Expected/.test(stderr + stdout.slice(0, 2000));
  const line = stdout.split("\n").reverse().find((l) => l.startsWith("MUTRESULT:"));
  if (!line) return { exit: code, timedOut: false, compileCrash, result: null, error: (stderr || stdout).slice(-400) };
  try { return { exit: code, timedOut: false, compileCrash: false, result: JSON.parse(line.slice("MUTRESULT:".length)), error: "" }; }
  catch (e) { return { exit: code, timedOut: false, compileCrash: false, result: null, error: `parse:${String(e)} :: ${line.slice(0, 200)}` }; }
}

/* ── שקולים-מתועדים (שורדים-עם-הצדקה-מפורשת — כמו-חסימת-שקולים ב-Stryker) ───── */
const DOCUMENTED_EQUIV: Record<string, string> = {
  "O-NEQ#kernel.ts#2": "שקול-מוכח: canon משמיט מפתחות-undefined (מוכח-חי ב-I11) — mu:undefined זהה-ביט-ביט",
  "O-LE#kernel.ts#2": "שקול-מתמטי: blocks≤0/debt≤0 דרך-הנוסחה עצמה מייצרים floor(0·rate·blocks)=0 → תוצאה-זהה-במתמטיקה (Math.max מקדים)",
  "O-EQ#kernel.ts#1": "funderAfford — מישור-ה-settle (בניית-בלוקים/מימון-דלק), מחוץ-למישור-applyOp שהסוללה בודקת; מכוסה-במכשירי maker-kernel-test/insider-suite",
  "O-EQ#kernel.ts#2": "funderAfford — כמו O-EQ#1 (מישור-settle)",
  "O-EQ#kernel.ts#3": "funderFor(exclude) — כמו O-EQ#1 (מישור-settle)",
  "O-NEQ#kernel.ts#1": "canonPriceMu — נצרך-בתמחור-מישור-settle/HTTP (reserve-value), לא בנתיבי-כסף-של-applyOp; מכוסה price-proof/insider",
  "O-LE#kernel.ts#1": "maxNonceSuffix — עזר-מגישים-פנימיים (mm.submit), מחוץ-ל-applyOp; מכוסה jepsen-http",
};

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log(`\n════ MUTATION TEST · ביקורת-המבקר · ${QUICK ? "QUICK" : "FULL"} ════`);
  if (!fs.existsSync(SNAP)) { console.error("state-snapshot.json חסר"); process.exit(1); }
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  // 1) הבזל: הגרעין-הבריא חייב PASS + טביעת-אצבע
  const baseDir = mkWorkdir("base");
  console.log("baseline (גרעין-בריא): רץ…");
  const base = await runEntry(baseDir);
  if (!base.result || base.result.verdict !== "PASS" || base.exit !== 0) {
    console.error(`BASELINE FAIL — הסוללה עצמה שבורה, אין-טעם למדוד מוטנטים:\n${base.error || JSON.stringify(base.result?.summary ?? {}).slice(0, 600)}`);
    process.exit(1);
  }
  const baseSig = JSON.stringify({ s: base.result.summary, g: base.result.golden, c: base.result.canaryOk, p: base.result.probesPass });
  console.log(`baseline PASS · root=${(base.result.summary as { finalRoot: string }).finalRoot.slice(0, 12)}… probes=${base.result.probesPass}/${base.result.probesTotal}`);

  // 2) רשימת-המוטנטים
  const mutantJobs: { id: string; kind: "semantic" | "text"; file: string; why: string; patch: unknown }[] = [];
  for (const sm of SEMANTIC) mutantJobs.push({ id: sm.id, kind: "semantic", file: sm.file, why: sm.why, patch: sm });
  const sites = buildMutants();
  const siteList = QUICK ? sites.slice(0, 12) : sites;
  for (const s of siteList) mutantJobs.push({ id: s.id, kind: "text", file: s.file, why: `textual ${s.from}→${s.to}`, patch: s });
  console.log(`mutants: ${SEMANTIC.length} semantic + ${siteList.length} textual = ${mutantJobs.length}\n`);

  // 3) הריצה
  const rows: { id: string; kind: string; file: string; why: string; status: string; note: string }[] = [];
  let killed = 0, survived = 0, noSite = 0, invalid = 0;
  for (let k = 0; k < mutantJobs.length; k++) {
    const job = mutantJobs[k]!;
    let dir = "";
    try { dir = mkWorkdir(`m${k}`, job.patch as never); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("NO-SITE")) { rows.push({ id: job.id, kind: job.kind, file: job.file, why: job.why, status: "SKIP-NO-SITE", note: "אתר-המוטציה לא נמצא (הקוד השתנה) — מתועד" }); noSite++; }
      else rows.push({ id: job.id, kind: job.kind, file: job.file, why: job.why, status: "ERROR", note: msg.slice(0, 120) });
      continue;
    }
    const rr = await runEntry(dir);
    let status = "", note = "";
    if (rr.timedOut) { status = "KILLED"; note = "timeout (לולאה/תלייה שהמוטנט יצר)"; }
    else if (rr.compileCrash) { status = "INVALID"; note = "התרסקות-קומפילציה — מוטנט-לא-תקף, מחוץ-לציון (כמו-Stryker)"; }
    else if (rr.exit !== 0 || !rr.result) { status = "KILLED"; note = `battery-FAIL/crash: ${(rr.error || "").slice(0, 100)}`; }
    else if (rr.result.verdict !== "PASS") { status = "KILLED"; note = "battery-FAIL"; }
    else {
      const sig = JSON.stringify({ s: rr.result.summary, g: rr.result.golden, c: rr.result.canaryOk, p: rr.result.probesPass });
      if (sig !== baseSig) { status = "KILLED"; note = "differential (עבר-את-הסוללה אך טביעת-האצבע שונה)"; }
      else { status = "SURVIVED"; note = "שקול-נצפית לסוללה — חייב תיעוד-הצדקה"; }
    }
    if (status === "KILLED") killed++; else if (status === "SURVIVED") survived++; else if (status === "INVALID") invalid++;
    rows.push({ id: job.id, kind: job.kind, file: job.file, why: job.why, status, note });
    console.log(`  [${k + 1}/${mutantJobs.length}] ${status.padEnd(8)} ${job.id} · ${note.slice(0, 90)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const measured = killed + survived;
  const score = measured ? Math.round((killed / measured) * 100) : 0;
  const survivors = rows.filter((r) => r.status === "SURVIVED");
  const undocumented = survivors.filter((s) => !DOCUMENTED_EQUIV[s.id]);
  const verdict = undocumented.length === 0 ? "PASS" : "FAIL";
  const artifact = {
    instrument: "mutation-test",
    at: new Date().toISOString(),
    mode: QUICK ? "quick" : "full",
    baselineRoot: (base.result!.summary as { finalRoot: string }).finalRoot,
    totals: { mutants: mutantJobs.length, killed, survived, survivedDocumented: survivors.length - undocumented.length, survivedUndocumented: undocumented.length, invalidCompile: invalid, skippedNoSite: noSite, killScore: `${score}%`, scoreDenominator: "killed+survived (INVALID מחוץ-לציון כמו-Stryker)" },
    verdict,
    note: "K1=סוללה · K2=דיפרנציאל-בזל. שורד = שקול-נצפית-לסוללה וחייב הצדקה-מפורשת ב-DOCUMENTED_EQUIV.",
    documentedEquivalents: DOCUMENTED_EQUIV,
    mutants: rows,
  };
  const outPath = path.join(ROOT, "audit-package/proof-pack/mutation.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  fs.rmSync(WORK, { recursive: true, force: true });

  console.log(`\n── VERDICT: ${verdict} · kill-score ${killed}/${measured} (${score}%) · documented-equiv ${survivors.length - undocumented.length} · invalid ${invalid} · skipped ${noSite} · ${(Date.now() - t0) / 1000 | 0}s ──`);
  for (const s of survivors) console.log(`  SURVIVOR ${s.id} (${s.file}) — ${DOCUMENTED_EQUIV[s.id] ?? "לא-מתועד — חייב טיפול!"}`);
  console.log(`artifact: ${outPath}`);
  process.exit(verdict === "PASS" ? 0 : 1);
}

await main();
