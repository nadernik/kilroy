#!/usr/bin/env python3
"""
Bundle the canonical supabase/ sources into one runtime asset the extension
can provision from.

The extension provisions a user's project by running the migrations and
deploying the functions itself, over the Management API. To do that it needs
the SQL and the function source at runtime — and it must be the SAME source
that supabase/ holds, not a hand-copied fork that drifts. So this reads the
canonical files and emits extension/provision/assets.js; nothing is authored
by hand in there.

Two shaping decisions, both to keep the deploy trivial:

  - The shared helper _shared/classify.ts is INLINED into each function, so
    each deploys as one self-contained module with no relative import to
    resolve. classify.ts imports nothing itself, which is what makes this safe.
  - Functions carry verify_jwt = false, the one setting a mail client depends
    on: it is hit without a login token and must not be turned away.

    python tools/bundle-provision.py
"""
import json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SB = ROOT / "supabase"
OUT = ROOT / "extension" / "provision" / "assets.js"

SHARED = SB / "functions" / "_shared" / "classify.ts"
IMPORT_RE = re.compile(r'^\s*import\s*\{[^}]*\}\s*from\s*"\.\./_shared/classify\.ts";\s*$', re.M)


def inline(func_path: Path) -> str:
    src = func_path.read_text(encoding="utf-8")
    if not IMPORT_RE.search(src):
        raise SystemExit(f"{func_path}: expected an import of _shared/classify.ts, found none")
    shared = SHARED.read_text(encoding="utf-8")
    # Drop `export ` so the inlined helpers are ordinary locals; the entry file
    # re-exporting them would be harmless but noisy.
    shared = re.sub(r'^export\s+', '', shared, flags=re.M)
    header = ("// --- inlined from _shared/classify.ts by tools/bundle-provision.py ---\n"
              f"{shared}\n"
              "// --- end inlined helpers ---\n\n")
    return header + IMPORT_RE.sub("", src, count=1).lstrip("\n")


migrations = []
for path in sorted(SB.glob("migrations/*.sql")):
    migrations.append({"name": path.name, "sql": path.read_text(encoding="utf-8")})
if not migrations:
    raise SystemExit("no migrations found")

functions = [
    {"slug": "px", "source": inline(SB / "functions" / "px" / "index.ts"), "verify_jwt": False},
    {"slug": "r",  "source": inline(SB / "functions" / "r" / "index.ts"),  "verify_jwt": False},
]

OUT.parent.mkdir(parents=True, exist_ok=True)
banner = ("/**\n"
          " * GENERATED — do not edit. Source of truth is supabase/.\n"
          " * Regenerate with: python tools/bundle-provision.py\n"
          " *\n"
          " * The migrations, in order, and the two Edge Functions with the shared\n"
          " * helper inlined, so provisioning can run them against a fresh project\n"
          " * without a CLI or the SQL editor.\n"
          " */\n\n")
body = (banner
        + "export const MIGRATIONS = " + json.dumps(migrations, indent=2, ensure_ascii=False) + ";\n\n"
        + "export const FUNCTIONS = " + json.dumps(functions, indent=2, ensure_ascii=False) + ";\n")
OUT.write_text(body, encoding="utf-8")

print(f"wrote {OUT.relative_to(ROOT)}")
print(f"  migrations: {', '.join(m['name'] for m in migrations)}")
print(f"  functions : {', '.join(f['slug'] + ' (verify_jwt=' + str(f['verify_jwt']).lower() + ')' for f in functions)}")
print(f"  size      : {OUT.stat().st_size:,} bytes")
