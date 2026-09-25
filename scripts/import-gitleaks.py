#!/usr/bin/env python3
"""Convert gitleaks' default rule set (MIT) into src/data/gitleaks-rules.json.

    curl -sL https://raw.githubusercontent.com/gitleaks/gitleaks/master/config/gitleaks.toml -o scripts/gitleaks.upstream.toml
    python3 scripts/import-gitleaks.py

Only the data revu's engine understands is kept: regex, keywords, entropy, secretGroup, allowlists.
"""
import json, pathlib, tomllib

root = pathlib.Path(__file__).resolve().parent
cfg = tomllib.loads((root / "gitleaks.upstream.toml").read_text())

def allowlists(d):
    out = []
    for a in d:
        item = {k: a[k] for k in ("regexes", "stopwords", "regexTarget", "condition") if k in a}
        if item.get("regexes") or item.get("stopwords"):
            out.append(item)
    return out

rules = []
for r in cfg["rules"]:
    if not r.get("regex"):          # path-only rules: revu handles sensitive file names itself (isSensitiveFile)
        continue
    rules.append({k: v for k, v in {
        "id": r["id"], "description": r.get("description", ""), "regex": r["regex"],
        "keywords": [k.lower() for k in r.get("keywords", [])],
        "entropy": r.get("entropy"), "secretGroup": r.get("secretGroup"), "path": r.get("path"),
        "allowlists": allowlists(r.get("allowlists", [])) or None,
    }.items() if v is not None})

g = cfg.get("allowlist", {})
out = {
    "source": "https://github.com/gitleaks/gitleaks (MIT) — config/gitleaks.toml",
    "minVersion": cfg.get("minVersion"),
    "global": {"regexes": g.get("regexes", []), "stopwords": g.get("stopwords", [])},
    "rules": rules,
}
dest = root.parent / "src" / "data" / "gitleaks-rules.json"
dest.write_text(json.dumps(out, separators=(",", ":")))
print(f"{len(rules)} rules → {dest} ({dest.stat().st_size // 1024} KB)")
