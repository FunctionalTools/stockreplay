"""Identify sources affecting a running checkout, including a ZIP installation."""

import hashlib
from pathlib import Path

root = Path(__file__).resolve().parents[1]
hash_ = hashlib.sha256()
for pattern in (
    "stockreplay/*.py",
    "frontend/src/**/*",
    "frontend/public/**/*",
    "frontend/*.html",
    "frontend/package*.json",
    "frontend/*.ts",
    "scripts/*.py",
    "setup.sh",
    "uv.lock",
):
    for path in sorted(root.glob(pattern)):
        if path.is_file():
            hash_.update(str(path.relative_to(root)).encode())
            hash_.update(path.read_bytes())
print(hash_.hexdigest())
