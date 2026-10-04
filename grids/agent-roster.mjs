// AGENT-ROSTER — שער-הדגלים-פר-סוכן של saos-dex (Z-87a · אחות-הרישום של steem/agent/lib/fleet-roster.cjs)
// ═══════════════════════════════════════════════════════════════════════════════
// אותו-אוצר-מילים של דגלי-השליטה (Task 11-c ב-repo-האם):
//   control: "full" | "partial" | "operator-delegated" | "blocked-no-key"
//   economicUse: boolean — מותר להשתמש בשורה כלכלית (מסחר/הנפקות)
//   capSbd: תקרת-נומינל פר-סוכן (SBD) — החלטת-בעלים, לא-נגזרת
//
// מקור-האמת כאן: grids/state/agent-swap-flags.json (מחויב-בגיט, שקוף-לכל) או
// קובץ-חוץ ב-AGENT_SWAP_ROSTER_PATH (עדכון-בעלים בלי-קומיט). ברירת-המחדל
// המבנית: כל-סוכן blocked-no-key + economicUse:false — אין-דגל = fail-closed.
//
// חוק-ברזל: אפס-סודות כאן — שמות-חשבון ציבוריים ודגלים בלבד.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FLAGS_PATH = join(HERE, "state", "agent-swap-flags.json");
export const FLAGS_SCHEMA = "agent-swap-flags-v1";

export const BLOCKED_DEFAULT = Object.freeze({ control: "blocked-no-key", economicUse: false, capSbd: 0, blockedReason: "no per-agent flag committed — fail-closed default (Z-87a)" });

function normalizeFlags(raw) {
  if (!raw || typeof raw !== "object" || raw.schema !== FLAGS_SCHEMA) return null;
  const agents = {};
  const src = typeof raw.agents === "object" && raw.agents != null ? raw.agents : {};
  for (const [k, v] of Object.entries(src)) {
    if (!v || typeof v !== "object") continue;
    agents[k] = {
      control: typeof v.control === "string" ? v.control : "blocked-no-key",
      economicUse: v.economicUse === true,
      capSbd: Number.isFinite(Number(v.capSbd)) ? Number(v.capSbd) : 0,
      blockedReason: typeof v.blockedReason === "string" ? v.blockedReason : null,
    };
  }
  const def = typeof raw.default === "object" && raw.default != null ? raw.default : null;
  return { schema: raw.schema, source: raw._source ?? "file", default: def, agents };
}

export function loadFlags({ env = process.env } = {}) {
  const candidates = [];
  if (env?.AGENT_SWAP_ROSTER_PATH) candidates.push(resolve(env.AGENT_SWAP_ROSTER_PATH));
  candidates.push(FLAGS_PATH);
  for (const p of candidates) {
    try {
      if (!p || !existsSync(p)) continue;
      const raw = JSON.parse(readFileSync(p, "utf8"));
      raw._source = p === FLAGS_PATH ? "grids/state/agent-swap-flags.json (committed)" : `env AGENT_SWAP_ROSTER_PATH -> ${p}`;
      const nf = normalizeFlags(raw);
      if (nf) return nf;
    } catch { /* קובץ-פגום → המשך-למועמד-הבא; אין-דגלים = fail-closed */ }
  }
  return { schema: FLAGS_SCHEMA, source: "no flags file found — structural fail-closed default", default: null, agents: {} };
}

/** הדגל-האמת לסוכן: ללא-רישום מפורש → blocked-no-key (fail-closed, לעולם לא ההפך). */
export function controlFor(agentId, { env = process.env, flags = null } = {}) {
  const f = flags ?? loadFlags({ env });
  const id = String(agentId ?? "").trim();
  if (!id) return { ...BLOCKED_DEFAULT, source: f.source, blockedReason: "empty agentId" };
  const row = f.agents?.[id];
  if (!row) {
    const d = f.default ?? BLOCKED_DEFAULT;
    return { ...BLOCKED_DEFAULT, control: d.control ?? BLOCKED_DEFAULT.control, economicUse: d.economicUse === true, capSbd: Number.isFinite(Number(d.capSbd)) ? Number(d.capSbd) : 0, blockedReason: d.blockedReason ?? BLOCKED_DEFAULT.blockedReason, source: f.source };
  }
  return { ...row, source: f.source };
}
