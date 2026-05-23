"""
Capture screenshots of each page in the MTECH app using Xvfb.
Run with: python3 capture_screenshots.py
"""
import os
import sys
import time
import subprocess

DISPLAY = ":99"
OUT_DIR = "/home/user/MTECH/manual_screenshots"
APP_DIR = "/home/user/MTECH/finfin_client"

os.makedirs(OUT_DIR, exist_ok=True)

# Kill stale Xvfb
subprocess.run(f"pkill -f 'Xvfb {DISPLAY}'", shell=True, capture_output=True)
time.sleep(0.5)

# Start Xvfb
print("Starting Xvfb...")
xvfb = subprocess.Popen(
    ["Xvfb", DISPLAY, "-screen", "0", "1280x800x24", "-ac"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
os.environ["DISPLAY"] = DISPLAY
time.sleep(1.5)

# Patch sys.path
sys.path.insert(0, APP_DIR)

# Patch config so app shows Dashboard (not Settings) on startup
import config as _cfg
_cfg.load = lambda: {"gas_url": "http://localhost", "api_key": "testkey"}

# Patch FinFinClient so network calls are no-ops
from api import FinFinClient, FinFinError

def _stub_init(self, gas_url, api_key):
    self.gas_url = gas_url
    self.api_key = api_key

def _stub_call(self, action, params=None, timeout=300):
    if action == "dashboard/refresh":
        return {
            "sheets": {
                "receipt": {"name": "Receipt05.2026", "found": True},
                "statement": {"name": "SCB05.2026", "found": True},
                "sum": {"name": "Sum05.2026", "found": True},
            },
            "parts": {
                "part1_tax": {"done": 142, "queued": 3,  "missing": 5},
                "part3_fee": {"done": 28,  "queued": 0,  "missing": 2},
                "part1_svc": {"done": 7,   "queued": 0,  "missing": 0},
                "part2_inv": {"done": 15,  "queued": 1,  "missing": 0},
            },
            "queues":    {"invoice": 1, "receipt": 3, "receipt_fee": 0},
            "errors":    [],
            "month":     "05.2026",
            "updatedAt": "2026-05-22T10:15:00",
        }
    if action == "notifications/list":
        return {
            "errors":  [],
            "actions": [
                {"label": "Part 1 ใบกำกับภาษี — มี 5 รายการยังไม่ออก",
                 "detail": "กด Run Part 1 เพื่อดำเนินการต่อ"},
            ],
            "pending": [
                {"label": "Queue receipt: 3 รายการ",
                 "detail": "ระบบ Poll ทุก 5 นาที — ไม่ต้องทำอะไร"},
            ],
            "lastRun": [
                {"part": "Part1", "success": 142, "queued": 3, "skip": 0, "error": 0,
                 "lastTs": "2026-05-22T10:10:00"},
                {"part": "Part2", "success": 15, "queued": 1, "skip": 2, "error": 0,
                 "lastTs": "2026-05-22T09:55:00"},
            ],
            "badge": 1,
            "generatedAt": "2026-05-22T10:15:00",
        }
    if action == "logs/tail":
        return [
            {"ts": "2026-05-22T10:10:05", "part": "Part1", "sheet": "Receipt05.2026",
             "row": 12, "inv": "1752001234", "status": "SUCCESS",
             "doc": "TAX2026050001", "msg": ""},
            {"ts": "2026-05-22T10:10:08", "part": "Part1", "sheet": "Receipt05.2026",
             "row": 13, "inv": "1752001235", "status": "QUEUE",
             "doc": "", "msg": "queued"},
            {"ts": "2026-05-22T09:55:02", "part": "Part2", "sheet": "Sum05.2026",
             "row": 5, "inv": "1752001100", "status": "SUCCESS",
             "doc": "INV2026050010", "msg": ""},
        ]
    if action == "ping":
        return {"pong": True}
    return {}

def _stub_ping(self):
    return {"pong": True}

FinFinClient.__init__ = _stub_init
FinFinClient.call     = _stub_call
FinFinClient.ping     = _stub_ping

# Patch _check_conn / _notif_auto to avoid threading noise on startup
import main as _main_mod

def _stub_check_conn(self, verbose=False):
    self.status_dot.configure(text="● Connected", fg="#15803d")

def _stub_notif_auto(self):
    pass  # disable auto-refresh loop during capture

_main_mod.MTechApp._check_conn  = _stub_check_conn
_main_mod.MTechApp._notif_auto  = _stub_notif_auto

from main import MTechApp

PAGES = ["dashboard", "tasks", "notifications", "settings", "logs"]
page_idx = [0]
app = [None]


def capture_page(page_name):
    path = f"{OUT_DIR}/ss_{page_name}.png"
    ret = os.system(f'scrot --quality 95 "{path}"')
    if ret == 0 and os.path.exists(path) and os.path.getsize(path) > 1000:
        sz = os.path.getsize(path)
        print(f"  ✓ {page_name} → {path}  ({sz:,} bytes)")
    else:
        print(f"  ✗ scrot failed for {page_name}")


def next_step():
    i = page_idx[0]
    if i >= len(PAGES):
        print("All screenshots done. Quitting.")
        app[0].quit()
        return

    page = PAGES[i]
    print(f"Navigating to: {page}")
    app[0]._show_page(page)
    app[0].update_idletasks()
    app[0].update()
    page_idx[0] += 1
    # wait 1.5s for render, then capture, then move to next
    app[0].after(1500, lambda p=page: (capture_page(p), app[0].after(400, next_step)))


print("Launching MTechApp...")
app[0] = MTechApp()

# Start screenshot loop after 3s startup
app[0].after(3000, next_step)
app[0].mainloop()

xvfb.terminate()
print("Done.")
