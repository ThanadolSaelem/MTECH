"""HTTP client for FinFin GAS Web App."""
from __future__ import annotations

import json
from typing import Any

import requests


class FinFinError(RuntimeError):
    pass


class NoInternetError(FinFinError):
    pass


class FinFinClient:
    def __init__(self, gas_url: str, api_key: str):
        self.gas_url = (gas_url or "").strip()
        self.api_key = (api_key or "").strip()

    def call(self, action: str, params: dict | None = None, timeout: int = 300) -> Any:
        if not self.gas_url:
            raise FinFinError("ยังไม่ได้ตั้งค่า GAS URL ในหน้า Settings")
        if not self.api_key:
            raise FinFinError("ยังไม่ได้ตั้งค่า API Key ในหน้า Settings")

        body = {
            "action": action,
            "apiKey": self.api_key,
            "params": params or {},
        }

        try:
            resp = requests.post(
                self.gas_url,
                data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json; charset=utf-8"},
                timeout=timeout,
                allow_redirects=True,
            )
        except requests.exceptions.ConnectionError as e:
            raise NoInternetError("เชื่อมต่ออินเทอร์เน็ตไม่ได้ — ตรวจสอบ WiFi") from e
        except requests.exceptions.Timeout as e:
            raise FinFinError(f"หมดเวลา ({timeout}s) — ลองใหม่อีกครั้ง") from e
        except requests.exceptions.RequestException as e:
            raise FinFinError(f"Request error: {e}") from e

        if resp.status_code != 200:
            raise FinFinError(f"HTTP {resp.status_code}: {resp.text[:300]}")

        try:
            obj = resp.json()
        except ValueError as e:
            raise FinFinError(f"Response ไม่ใช่ JSON:\n{resp.text[:300]}") from e

        if not obj.get("ok"):
            raise FinFinError(obj.get("error") or "Unknown error from GAS")

        return obj.get("data")

    def ping(self) -> dict:
        return self.call("ping", timeout=30)
