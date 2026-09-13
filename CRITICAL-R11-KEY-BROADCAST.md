<!-- hardening:allow-file ALL reason=urgent alert; describes the exposure by path, field name and length only - no secret value appears -->

# CRITICAL - every root secret of the estate is committed to eight repositories, with its passphrase beside it

Read on 2026-09-12 from live repository contents. **No archive was opened, nothing
was decrypted, and no secret value appears in this document.** Every secret below is
described by path, field name, length and character class only.

---

## What was pushed, and where

On 2026-09-12 a "sovereign access generation" (labelled **R11**) was committed to
the partner repositories. Verified present in **eight of nine** scanned:

    saos-dex · roshpina · Saosmartwallet · steem
    saos-sovereign-foundry · Project-files · anchor-baseline · saos-jummper

Three files in each, at identical sizes:

    agent/vault/KEYS-ACCESS-2026-09-12.tar.enc      138,288 bytes
    agent/vault/recovery-meta-2026-09-12.json           478 bytes
    agent/vault/KEYS-ACCESS-README-HE.md              5,928 bytes

The README states it was sent **"בבת-אחת לכל-11 ריפואי-השותפים"** - to all eleven
partner repositories at once, create-only, under an owner instruction dated
2026-09-12: *"תדאג שגם לדקס יהיה גישה... אין לי סבלנות לשלוח אחד אחד לכולם"*.

`saos-sovereign-platform` was not found to carry it in this scan.

---

## The passphrase is committed beside the archive

`agent/vault/recovery-meta-2026-09-12.json`, field names and value lengths only:

    generation              str  len=10   text
    keys_access_2026_09_12  str  len=48   hex      <- the passphrase for the archive
    policy                  str  len=97   text
    order                   str  len=87   text
    sealedBy                str  len=31   text

And the README says so in its own words, line 9:

> **הסיסמה מאוכסנת ב-`recovery-meta-2026-09-12.json` בריפו-הפרטי הזה** — יחד עם
> כל-נתוני-הדור. עידן-הסיסמאות-בצ'אט-בלבד הסתיים: כל-reset משחזר-הכל מהריפו לבד,
> בלי-תלות בהמשכיות-שיחה.

and gives the exact decrypt command, lines 44-47:

>     PASS=$(python3 -c "import json;print(json.load(open('recovery-meta-2026-09-12.json'))['keys_access_2026_09_12'])")
>     openssl enc -d -aes-256-cbc -pbkdf2 -iter 300000 \
>       -in KEYS-ACCESS-2026-09-12.tar.enc -out keys-access.tar.gz -pass pass:$PASS

**The archive is AES-256-CBC with PBKDF2 at 300,000 iterations.** That is real
cryptography. **It is also irrelevant here**, because the passphrase is in the file
next to it, in the same repository, and the README prints the command that joins
them.

---

## What the README says is inside

Reproduced from its own contents table, because the inventory matters more than any
assessment of it:

| inside the archive | contents |
|---|---|
| `fleet_keys.enc` + `fleet_keys.meta.json` | **the live vault - 14 members: both roots, `vault.json` (12 accounts' WIFs), `vault.enc`, `.vaultkey`, an address registry, gate tokens** |
| `vault.json` | **12 accounts (11 soldiers + @headcorner) - WIFs** |
| sovereign-root json | **the 24-word BIP39 Coinomi mnemonic**, from which 120 HD addresses derive |
| hd-addresses json | **120 HD addresses** - EVM across 7 networks, TRON, SOL, BTC |
| identity-root txt | **the 12-word identity root**, stated as verified byte-for-byte against mainnet evidence: EVM `0x7b7869d1…2c31`, TRON `TAzZZkrw…qkGr` |
| doors txt | door mnemonics `sov:0..5` |
| `key-broker.token` | **the signing-gate token** (port 3040) |
| owner-passwords txt | **the owner's 8-password document - the soldier derivation source** |
| legacy-authority txt | a dead generation, kept for documentation |
| `agent/.env` | **the live WIFs of @headcorner on STEEM**, plus `VAULT_MODE` |
| `agent/MANIFEST.txt` | sha256 of every file inside |

**That is the complete root of the estate.** Both sovereign roots, twelve accounts'
signing keys, 120 derived addresses across eleven chains, the owner's password
document, the live STEEM WIFs of the primary account, and the token for the signing
gate - in one archive, replicated eight times, with its passphrase beside each copy.

---

## The stated discipline, and why it does not hold

The README's own discipline section:

> **אף-מפתח-פרטי לעולם לא בגיט בצורה-גלויה** — רק בתוך המעטפת המוצפנת הזו.
> **בצ'אט: לעולם לא להדפיס סודות** — רק נתיבים, כתובות-פומביות ומספרים.

Both rules were followed in form. Nothing is printed in plaintext, and nothing was
sent through chat. **And both are violated in substance**, because:

> A private key inside an encrypted envelope, whose passphrase is committed in the
> file beside it, is a private key in git.

The encryption moves the secret one step away. It does not protect it. This is the
same reasoning that was written into `.gitignore` amendment 117i - *"ciphertext and
pass travel together in the PRIVATE repo; the repo holder is trusted by
definition"* - and it is the reasoning that produced `fleet_keys.enc` beside
`fleet_keys.meta.json`, which was reported and removed earlier in this engagement.

**The removal was reversed and generalised.** The pattern that was fixed in one
repository is now in eight, carrying strictly more material than before.

---

## Aggravating factors

1. **The repositories are readable by a classic PAT** carrying `admin:org`,
   `admin:enterprise`, `delete_repo`, `admin:ssh_signing_key`, `admin:public_key`,
   `workflow`, `write:packages`, `codespace` and `audit_log`. That token has been
   pasted into a chat conversation repeatedly. Anyone holding it can read all eight
   copies.
2. **Two of the eight have no operational need.** `Project-files` is an archive of
   ten ZIPs; `anchor-baseline` is a baseline restore. Neither runs an agent.
3. **`saos-jummper` is included** - the repository this engagement has written to,
   which has been kept free of key material in every one of its 198 files until
   this generation landed. It was added create-only, without touching anything
   existing, which is why no check fired.
4. **It is permanent.** Eight copies in git history. Removing them from HEAD, as was
   done for `fleet_keys.enc`, does not remove them from history - and this time
   there are eight histories.
5. **The README instructs autonomous action on the material it exposes**: "חתימה
   מהכספת — EVM (EIP-191) · TRON · SOL", "עיגון בגז-אפס", "שחזור-עצמי מלא — אחרי
   כל reset: ריפו זה מחזיר את כל-המפתחות לבד". Any agent with repo read access is
   now one `openssl` command from signing as every account in the estate.

---

## What to do, now, in this order

| # | action | why first |
|---|---|---|
| **1** | **Rotate both sovereign roots and all twelve accounts' WIFs.** Assume every key in the archive is public. | The passphrase is committed in eight repositories. Rotation is the only action that cannot be undone by someone else |
| **2** | **Revoke the classic PAT immediately**, then investigate its use. | It can read all eight copies, delete repositories and install SSH signing keys |
| **3** | **Rotate the owner's eight passwords** and the `key-broker.token`. | Both are named in the archive's own inventory |
| **4** | **Remove `agent/vault/` from all eight repositories**, including `saos-jummper`. | Stops forward exposure. Does not undo history |
| **5** | **Stop the distribution mechanism.** Whatever pushed R11 to eleven repositories will push R12. | Eight copies became eight because one instruction said "send to everyone" |
| 6 | Reverse `.gitignore` amendment 117i and the 2026-09-10 custody instruction, in writing | Both encode the reasoning that produced this |
| 7 | Move the archives to a location that is not a git repository - hardware, an air-gapped machine, or a secret manager. Passphrases to a channel that is not the repository holding the ciphertext | |
| 8 | Re-derive the 120 HD addresses and check whether any moved funds since 2026-09-12 | The addresses are public knowledge now |

**Actions 1 through 3 are the ones that matter.** Everything else limits future
exposure; only rotation limits what the current exposure can do.

---

## What this document is not

It is not an accusation about intent. The instruction that produced this was about
convenience - not sending keys to eleven agents one at a time - and the mechanism
that satisfied it was the only one available: a repository every agent can read.
**The convenience was real and the mechanism was wrong.** There is no version of
"every agent can self-restore after a reset" that is also "the root secrets are not
readable by everyone with repo access", unless the restoring secret lives somewhere
other than the repository.

It is also not a claim that the archive was decrypted. It was not. Nothing here
required decrypting it, because the README documents its contents and the metadata
file documents how.

---

## What was read, and what was not

**Read:** file existence and sizes across nine repositories; `recovery-meta-2026-09-12.json`
parsed for field names, value lengths and character classes only; `KEYS-ACCESS-README-HE.md`
in full, with every run of 16 or more alphanumeric characters redacted before it was
displayed.

**Not read:** the archive itself, which was never downloaded or decrypted. No
passphrase, mnemonic, WIF, token or private key was printed, copied, transmitted or
stored. The one field that holds the passphrase is described here as `len=48 hex`
and nothing more.

**Detection method:** `src/jumpper/secretsweep.py`, which searches for the pattern
*an encrypted archive plus a plaintext credential that opens it, in one repository*
rather than for a filename. It found this in one pass across nine repositories. The
earlier `fleet_keys` fix was found by name and missed two instances of the same
shape; this sweep was written so that it could not.

---

*Read-only throughout. No file in any repository was created, modified or deleted
except this document, added to saos-jummper and to the repositories carrying the
exposure so that every agent with access sees it.*
