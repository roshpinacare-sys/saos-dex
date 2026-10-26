#!/usr/bin/env bun
/**
 * hbd-regime-selftest.mjs — גל-81 · מבחני-קבלה למשטר-החתך HBD
 * אפס-רשת, דטרמיניסטי. exitCode=1 על-כל-אדום.
 */
import { hbdMarkRegime, HBD_PRINT_PEG_USD } from "./hbd-regime.mjs";

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  console.log(`${ok ? " ✓" : " ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : (fail++, (process.exitCode = 1));
};

/* 1 · החתך-מיושם: חותם-גולמי-כלשהו → הפגיון */
{
  const r = hbdMarkRegime(1.79);
  t("raw 1.79 → mark = print peg 1.00", r.mark === 1.0 && r.regime === "print-peg-1.00", `mark=${r.mark}`);
  t("raw preserved for audit", r.raw === 1.79);
  t("dev bps honest: |1.79-1.0|/1.0 = 7900bps", r.devBps === 7900, `devBps=${r.devBps}`);
  t("note publishes the doctrine + raw deviation", r.note.includes("haircut") && r.note.includes("7900"));
}

/* 2 · המדידה-החיה-של-גל-81: 1.79 לא ינתק-שווא את הרגל — הסטייה-מדודה כנגד-הפגיון */
{
  const live = hbdMarkRegime(1.79);
  const hiveUsd = 0.047633;
  const parity = hiveUsd / live.mark;
  const bookMid = 0.0480897;
  const devBps = Math.abs(bookMid - parity) / parity * 10000;
  t("live-measured: parity vs peg ≈ 96bps (NOT 8071) — leg re-arms", devBps < 500 && devBps > 50, `dev=${Math.round(devBps)}bps`);
}

/* 3 · חותם-תקין-ליד-הפגיון → אותו-חתך (הדוקטרינה-קבועה, לא-תנאית) */
{
  const r = hbdMarkRegime(0.998);
  t("raw 0.998 → mark still peg 1.00 (doctrine is unconditional)", r.mark === 1.0);
  t("dev 20bps published (|0.998-1.0|/1.0 = 20bps)", r.devBps === 20);
}

/* 4 · fail-honest: בלי-קלט → אין-סימון, אין-מסחר */
{
  for (const bad of [null, undefined, 0, -1.2, NaN]) {
    const r = hbdMarkRegime(bad);
    t(`raw ${String(bad)} → mark=null (fail-honest)`, r.mark === null && r.regime === "unavailable" && r.devBps === null);
  }
}

/* 5 · הפגיון-עצמו */
t("HBD_PRINT_PEG_USD === 1.0 (print regime)", HBD_PRINT_PEG_USD === 1.0);

console.log(`\npass=${pass} fail=${fail} — ${fail === 0 ? "ALL GREEN" : "RED"}`);
process.exit(fail === 0 ? 0 : 1);
