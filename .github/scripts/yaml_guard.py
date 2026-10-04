#!/usr/bin/env python3
# WORKFLOW-YAML-GUARD (sovereign, zero third-party) — Z-74 law propagated from Zip
# Every push YAML-parses every workflow file; a broken file lands as a NAMED red
# (file + line + reason) on the very push that introduces it.
# Root cause this guards against (measured in Zip, 2026-10-03): heredoc body at
# column 1 split the `run: |` block scalar → 10 consecutive parse-deaths blamed
# on "billing". No workflow file lands silently broken again.
import glob
import sys

try:
    import yaml
except ImportError:
    print("GUARD-INCONCLUSIVE: PyYAML unavailable on runner (fail-open is forbidden) — treat as red")
    sys.exit(2)

files = sorted(glob.glob(".github/workflows/*.yml") + glob.glob(".github/workflows/*.yaml"))
if not files:
    print("no workflow files found — nothing to guard")
    sys.exit(0)

bad = 0
for f in files:
    try:
        with open(f, encoding="utf-8") as fh:
            yaml.safe_load(fh)
        print(f"OK   {f}")
    except Exception as e:
        bad += 1
        line = "?"
        mark = getattr(e, "problem_mark", None)
        if mark is not None:
            line = mark.line + 1
        print(f"FAIL {f}: line {line} — {e}")

print(f"\nyaml-guard: {len(files) - bad}/{len(files)} clean")
sys.exit(1 if bad else 0)
