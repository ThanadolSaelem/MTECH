"""Local config persistence (%APPDATA%\\FinFin\\config.json)"""
from __future__ import annotations

import json
import os
from pathlib import Path

APPDATA_DIR = Path(os.environ.get("APPDATA", Path.home())) / "FinFin"
CONFIG_FILE = APPDATA_DIR / "config.json"

DEFAULT: dict = {
    "gas_url": "",
    "api_key": "",
}


def load() -> dict:
    if CONFIG_FILE.exists():
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            return {**DEFAULT, **data}
        except Exception:
            pass
    return DEFAULT.copy()


def save(cfg: dict) -> None:
    APPDATA_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
