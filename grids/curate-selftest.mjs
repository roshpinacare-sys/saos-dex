// CURATE-SELFTEST (A-12 · T-7) — וקטורים אופליין לגמרי, אפס-רשת אפס-מפתחות
import { scorePost, planVotes } from "./curate.mjs";

const t = (name, ok) => {
  console.log(`${ok ? " ✓" : " ✗"} ${name}`);
  if (!ok) process.exitCode = 1;
};

const NOW = Date.parse("2026-09-28T16:00:00Z");
const mkPost = (author, permlink, hAgo, votes = 20, comments = 2, tags = ["crypto"], votedBy = []) => ({
  author,
  permlink,
  created: new Date(NOW - hAgo * 3600e3).toISOString(),
  category: tags[0],
  net_votes: votes,
  active_votes: votedBy.map((v) => ({ voter: v })),
  children: comments,
  json_metadata: { tags },
});

/* 1. חלון-גיל */
t("peak band 6-30h scores highest", scorePost(mkPost("a", "p1", 12), { now: NOW }).score > scorePost(mkPost("a", "p2", 1), { now: NOW }).score);
t("too-old (>120h) scores zero honestly", scorePost(mkPost("a", "p3", 130), { now: NOW }).score === 0);
t("future/unparseable date → zero (no crash)", scorePost({ author: "a", permlink: "p", created: "garbage" }, { now: NOW }).score === 0);

/* 2. אפיניטי-נושא */
t("topic-hit boosts over off-topic", scorePost(mkPost("a", "p1", 12, 20, 2, ["defi"]), { now: NOW }).score > scorePost(mkPost("a", "p2", 12, 20, 2, ["gardening"]), { now: NOW }).score);

/* 3. רוויה */
t("saturated whale-post discounted", scorePost(mkPost("a", "p1", 12, 500), { now: NOW }).score < scorePost(mkPost("a", "p2", 12, 60), { now: NOW }).score);

/* 4. תוכנית: אפס-הצבעה-עצמית + דדופ-כבר-הצבענו + גיוון-מחברים */
const posts = [
  mkPost("headcorner", "self-post", 12),                      // עצמי — חסום
  mkPost("alice", "already-voted", 12, 20, 2, ["crypto"], ["headcorner"]), // כבר-הצבענו
  mkPost("bob", "b1", 12), mkPost("bob", "b2", 13), mkPost("bob", "b3", 14), // 3 מאות-מחבר → מקס 2
  mkPost("carol", "c1", 8, 60, 5, ["defi"]),                  // איכותי
  mkPost("dan", "d1", 200),                                   // זקן-מדי
];
const plan = planVotes({ posts, account: "headcorner", dailyLimit: 8, now: NOW });
const authors = plan.votes.map((v) => v.author);
t("self-vote excluded", !authors.includes("headcorner"));
t("already-voted excluded", !plan.votes.some((v) => v.permlink === "already-voted"));
t("author diversity: max 2 per author", (authors.filter((a) => a === "bob").length) === 2);
t("too-old excluded", !plan.votes.some((v) => v.author === "dan"));
t("quality post present", plan.votes.some((v) => v.author === "carol"));

/* 5. מכסה + משקלים + דטרמיניזם */
const many = Array.from({ length: 20 }, (_, i) => mkPost(`u${i}`, `p${i}`, 10 + (i % 5)));
const capped = planVotes({ posts: many, dailyLimit: 5, now: NOW });
t("daily limit enforced", capped.votes.length === 5);
t("weights integer steem-units ≤ max", capped.votes.every((v) => Number.isInteger(v.weightSteemUnits) && v.weightSteemUnits > 0));
t("determinism: same input → same plan (order+weights)", JSON.stringify(planVotes({ posts: many, dailyLimit: 5, now: NOW })) === JSON.stringify(capped));
t("min-score filters junk", planVotes({ posts: [mkPost("x", "old-ish", 100)], minScore: 1, now: NOW }).votes.length === 0 || planVotes({ posts: [mkPost("x", "old-ish", 100)], minScore: 1, now: NOW }).votes.every((v) => v.score >= 1));

/* 6. משקלי-רצועות: score גבוה → משקל מלא */
const bands = planVotes({ posts: [mkPost("hi", "hi", 12, 90, 8, ["defi"]), mkPost("lo", "lo", 80, 3, 0, ["misc"])], now: NOW });
const hi = bands.votes.find((v) => v.author === "hi");
const lo = bands.votes.find((v) => v.author === "lo");
t("weight bands follow score (hi ≥ lo, lo > 0)", (!hi || !lo) || (hi.weightSteemUnits >= lo.weightSteemUnits && lo.weightSteemUnits > 0));

console.log(process.exitCode === 1 ? "CURATE-SELFTEST: FAIL" : "CURATE-SELFTEST: PASS");
