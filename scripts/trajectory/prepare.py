"""Import a trusted Wrangler D1 export locally; preserve every original row."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys

if len(sys.argv) != 3:
    raise SystemExit("Usage: python3 scripts/trajectory/prepare.py <snapshot.sql> <output-directory>")
os.umask(0o077)
source, output = Path(sys.argv[1]), Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True, mode=0o700)
snapshot = output / "snapshot.sqlite"
if snapshot.exists():
    raise SystemExit(f"Refusing to overwrite existing database: {snapshot}")
sql = source.read_bytes()
# Import in memory to avoid a disk transaction for every exported INSERT.
db = sqlite3.connect(":memory:")
db.row_factory = sqlite3.Row
db.executescript(sql.decode("utf-8"))
integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
if integrity != "ok":
    raise SystemExit(f"SQLite integrity check failed: {integrity}")
for table in ("Locations", "Projects"):
    rows = [dict(row) for row in db.execute(f'SELECT * FROM "{table}" ORDER BY ID')]
    path = output / f"{table.lower()}.json"
    path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    path.chmod(0o600)
with sqlite3.connect(snapshot) as disk:
    db.backup(disk)
snapshot.chmod(0o600)
tables = {row[0]: db.execute(f'SELECT COUNT(*) FROM "{row[0].replace(chr(34), chr(34) * 2)}"').fetchone()[0]
          for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
metadata = {"sqlSha256": hashlib.sha256(sql).hexdigest(), "sqlBytes": len(sql),
            "integrityCheck": integrity, "tables": tables}
(output / "snapshot-metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
print(json.dumps(metadata, indent=2))
