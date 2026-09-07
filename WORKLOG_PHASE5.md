# WORKLOG PHASE 5 — שחזור-הלב · עיגון-חי · הרחבת-אופקים (Ethereum & Solana)

> יומן-מסע מסכם: משחזור-המפתחות מ-`steem@main`, דרך עיגון-חי מאומת על Steem ו-Hive,
> ועד אינטגרציית ETH/SOL ל-Relay — עם זהויות-הצי האמתיות, חתימה-חיה אפס-גז,
> ושערי-מדיניות כנים. אפס סודות במסמך זה (מיקומים בלבד).

---

## 1 · שחזור המפתחות מ-`steem@main` (Key Recovery)

* **הבעיה**: איפוס-סנדבוקס מחק את עץ-ה-DEX ואת ה-.env (מורשת "iron law" — סודות-פלטה
  לעולם לא בגיט). ה-Relay נותר ללא-מפתחות → עיגון מושהה בכנות.
* **הכספת**: `steem@main · agent/fleet_keys.enc` (170,905B, AES-256-GCM, scrypt KDF) +
  `fleet_keys.meta.json` (מחזיק-passphrase) + `fleet_vault.cjs` (`--open`).
* **הפענוח**: GCM-tag מאומת → שחזור verbatim של `keys/vault.json` (11 חשבונות-צי),
  `keys/wallets-seed.json` (הזרע-הריבוני, Task-113), `keys/wallets-registry.json`
  (12 סוכנים × EVM/TRON/SOL/BTC), `keys/tron-mnemonic.txt`, `.env` (WIFs).
* **שרשרת-אימות כפולה**: WIF→pub (secp256k1, checksum) == pub-שמור == **רשות-ה-active
  החיה של @headcorner על Steem וגם על Hive** (RPC ציבורי, אותו מפתח — הוכח קריפטוגרפית).
* **מניפסט-הזהויות**: `steem@main · sovereign/node/wallets-public.json` — מעוגן-כבר-על-השרשרת
  (txid `9f593bdc88a62c7a7fcd568ef0edf50bbf20f96d`, verified, manifestDigest `4442c2b9…`).
  כתובות headcorner (idx=2): EVM `0x2767e8146c11baD1d9B0784f11325375195c1b0f` ·
  SOL `9knfnFMLmhUNjKRDbR1BmVnVkq4BRczyYjJ7BqiZSgiL` · TRON `TG6SrsMJjRqnqAyYM8kGZu1rgkpsgizKEn` ·
  BTC `bc1qf7czhpnpkc8mwx32r5gleqw0kj99j823822pmg`.

## 2 · תיקון-באג ה-instrumentation והזרקת ה-.env

* **הבאג**: next/bun אינם טוענים .env לתהליך-ילד שנוצר עם אובייקט-env מפורש —
  הדמון-3010 (שנוצר-ע"י instrumentation) עלה ללא-מפתחות.
* **התיקון** (`src/instrumentation.ts` בפרויקט-האם): קריאת `saos-dex/.env` בזמן-ריצה +
  הזרקת-מפתחות ל-env-הילד. אפס סודות בקוד/בגיט — הקריאה מקובץ-ריצה gitignored בלבד.
* **הזרקה**: `saos-dex/.env` (mode 600, gitignore שורות 7-8): `SAOS_RELAY_AGENT_ACCOUNT`,
  `STEEM_ACTIVE_WIF`, `HIVE_ACTIVE_WIF`, `HIVE_ANCHOR_ACCOUNT`, `DATABASE_URL=dex.db`,
  ובהמשך-השלב: `ETH_PRIVATE_KEY`, `ETH_EXPECTED_ADDRESS`, `SOL_PRIVATE_KEY`,
  `SOL_EXPECTED_ADDRESS` (headcorner idx=2 — הוצלבו מול-המניפסט-המעוגן: PASS).

## 3 · חיבור-חי ל-Steem/Hive (עם txids מאומתים)

* ה-Relay עלה מאויש; Steem מעגן **כל-חותם** (כל-12 בלוקים), Hive בקצב-RC כנה
  (mana מתכווץ — ידלק לבד), TRON מותנה-מימון כנה (0 TRX מדיד).
* **עיגונים-חיים מהמפעילה-הראשונה אחרי-השחזור** (KEYRELAY): Steem h540
  `ba32766fa166d52e…` · h552 Steem `e7514750246ad004…` + Hive `c36ae87ec711d11e…`
  (אותו stateRoot על שתי-השרשראות, אומת מול-RPC ציבורי, 0 mismatches).
* **הרצה-נוכחית** (אחרי-איפוס-הסנדבוקס השני + שחזור-מלא): Steem txid `ae299b47…`
  ואז `f5f26d11…` — 16 anchored / 14 verified / **0 mismatches**, breakers closed ×5.
* **verifyOnChain** (אי-אמון-עצמי): כל-txid נקרא-חזרה מ-RPC ציבורי ומושווה ביט-מול-ביט.

## 4 · סריקת ETH/SOL — ממצאים ומסקנות-ארכיטקטוניות

### 4.1 ממצאי-הסריקה (8 ריפואים: foundry, dex, steem, platform, Saosmartwallet, anchor-baseline, roshpina, Project-files)

| נכס | מקום | מה-שם |
|---|---|---|
| זהויות-EVM+SOL לכל-הצי (מפתחות+כתובות) | `steem@main` → כספת → `keys/wallets-registry.json` | 12 סוכנים × (evm `m/44'/60'/0'/0/i` 7 רשתות · sol sha256(seed\|sol\|name)→ed25519) |
| מנוע-הגזירה | `steem@main · sovereign/node/wallets.cjs` | ethers HDNodeWallet + @noble/curves ed25519 + manifestDigest-guard |
| ארנק-חוצה-פרדיגמות + ממסר-ללא-גז | `steem@main · agent/xwallet.cjs` (+ `identity.cjs`) | **EIP-191 intent-signing עם ecrecover-verify + gas-tank ledger** · **עסקת-Solana חיה על devnet** (fee-payer, compact-u16, SPL-Memo v2) |
| חוזים-חכמים (.sol / Anchor-.rs) | **לא נמצאו בשום-ריפו** | אין Solidity, אין תוכניות-Anchor |
| ethers/viem/web3/@solana/web3.js ב-DEX | לא-נמצאו | ה-DEX לא דיבר EVM/SVM עד-השלב-הזה |

### 4.2 המסקנות (שלוש-השאלות)

1. **התאמת-מפתחות**: ה-WIF של headcorner הוא secp256k1 — **אותה-עקומה של Ethereum**
   (EIP-191/ECDSA): הסקלר יכול תיאורטית לחתום על ETH. אך נגזרת-הזהות שונה
   (ETH = keccak256(pub-לא-דחוס)[12:] מול Graphene = sha256-דחוס) ולכן **ההחלטה-המוסדית:
   זהות-ETH נפרדת** (צי idx=2 מהזרע-הריבוני, מעוגנת-כבר-במניפסט) — בידוד-סמכות
   בין ה-Graphene-סמכות לבין כספי-EVM. **Solana = Ed25519 — לא-ניתן לחתימה עם ה-WIF**;
   הזהות-SOL נגזרת מהזרע (sha256(seed\|sol\|headcorner) → ed25519).
2. **עיגון-ה-StateRoot**: stateRoot הוא sha256 = 32 בייטים = **bytes32 נטיבי ל-ETH**
   (calldata) — ללא-המרה. על SOL הוא רוכב בממו (בייטים חופשיים) — ללא-המרה.
   אותו-payload קנוני משותף לכל-חמש-השרשראות (עיגון-עצמו-עקבי).
3. **עלויות-והיתכנות**: Steem/Hive = RC (אפס-עלות); ETH-L1 = גז-אמת. התשובה-כבר-בקוד
   שנמצא: **(א)** gasless-intent-relay (xwallet `--evm-intent`): לקוח חותם EIP-191
   (אפס-גז), relayer מאמת ecrecover, gas-tank ledger מחייב (policy `intent-fee-routing`,
   מתומן ב-SAOS) · **(ב)** fee-payer על Solana (xwallet `--solana-feed` — הוכח-חי על
   devnet) · **(ג)** L2: ה-registry כבר מגדיר arbitrum/optimism/base — אותה-מתמטיקת-EVM,
   החלפת-chainId+RPC בלבד (`ETH_RPC_URL`).

## 5 · סטטוס-האינטגרציה (מה בוצע, מה בתכנון)

### בוצע (השלב הזה)

* **`src/lib/dex/relay-eth.ts`** — מתאם-Ethereum: זהות-צי (EIP-55, fail-closed מול
  `ETH_EXPECTED_ADDRESS`) · **טירה-1: כוונות-EIP-191 חתומות-חי על כל-חותם** (אפס-גז,
  ניתנות-לאימות-צד-שלישי ב-ecrecover — h516/h528/h612 כבר חתומות, verified:true) ·
  **טירה-2: שידור-EIP-1559** (RLP מלא, calldata=payload, nonce/gasPrice מ-RPC,
  verify מול-receipt+input) — **נעול-מדיניות** (`ETH_BROADCAST_ENABLED`, ברירת-מחדל OFF
  לפי-הנחיית-המפעיל: אפס בזבוז-גז) ואז עדיין חסם-יתרה (gas floor).
* **`src/lib/dex/relay-sol.ts`** — מתאם-Solana: זהות-צי (ed25519-seed32 → base58,
  fail-closed מול `SOL_EXPECTED_ADDRESS`) · בניית-מסר מלאה (compact-u16 header,
  SPL-Memo v2 `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`, blockhash מ-RPC) + חתימה
  חיה · שידור-נעול-מדיניות (`SOL_BROADCAST_ENABLED`) ואז חסם-יתרה (10K lamports) ·
  verify מול-getSignatureStatuses+getTransaction-logMessages.
* **relay.ts** — `ChainName` עתה 5 שרשראות; eth/sol בתור-החותמים (LATEST_ONLY —
  משמעת-תקציב כמו hive/tron), שערי-ה-"unfunded-policy" מסווגים כהמתנה-כלכלית כנה
  (לא-נספרים ל-breaker), fail-closed על אי-התאמת-זהות-נגזרת, `identities`+`ethIntents`
  חשופים ב-API. Circuit breakers/backoff/reconciliation/verifyOnChain — אחידים לכולם.
* **UI** — System Health עתה 5 שרשראות: ETH/SOL עם תג-`PENDING FUNDING — ARMED`,
  כרטיס-זהויות-הצי (מעוגן-מניפסט) וכוונת-EIP-191 האחרונה (verified).
* **audit-package** — resync מלא: relay.ts/chaos.ts/chain.ts byte-identical,
  relay-eth.ts+relay-sol.ts חדשים, FIDELITY.diff עדיין שורה-אחת-מתועדת,
  MANIFEST.sha256 (12 קבצים), typecheck-עצמאי ירוק.
* **chain.ts** — תיקון-תצפית: `dbOk` עתה מאושר-מחדש בהצלחה (היה דומם-לשלילה).
* **tsconfig** — target ES2020 (BigInt literals ל-RLP).

### בתכנון (מתועד, לא-מבוצע בכוונה)

* **חמוש-מימון**: המפעיל מממן `0x2767e814…b0f` (גז) / `9knfnFML…giL` (SOL) → מדליק
  `ETH_BROADCAST_ENABLED=1` / `SOL_BROADCAST_ENABLED=1` → ה-Relay מעגן stateRoot
  bytes32 על ETH (calldata) וממו-SPL על SOL — עם אותם verifyOnChain/breakers.
* **L2-route**: `ETH_RPC_URL` → arbitrum/optimism/base (אותו-מודול, עלות-שבריר).
* **התמדת-כוונות**: EIP-191 intents עתה בזיכרון+API; להוסיף ל-anchors.json בעתיד.
* **mainnet-SOL**: `SOL_RPC_URL` עוקיף — המודול זהה.

---

*נכתב אוטומטית במסגרת פקודת "הרחבת-אופקים" — אפס סודות במסמך (מיקומים/כתובות-ציבוריות בלבד).*
