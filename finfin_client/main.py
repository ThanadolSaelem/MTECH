"""MTECH — desktop client."""
from __future__ import annotations

import threading
import tkinter as tk
import tkinter.font as tkfont
from datetime import datetime

import customtkinter as ctk

import config
from api import FinFinClient, NoInternetError

APP_TITLE = "MTECH ระบบบัญชี"
APP_SIZE  = "1100x720"

ctk.set_appearance_mode("Light")
ctk.set_default_color_theme("blue")


def _detect_font() -> str:
    try:
        root = tk.Tk()
        root.withdraw()
        families = set(tkfont.families(root))
        root.destroy()
        for f in ("Leelawadee UI", "Leelawadee", "Tahoma", "Arial"):
            if f in families:
                return f
    except Exception:
        pass
    return "Tahoma"

FONT = _detect_font()

# ── Palette (Tesla-inspired light) ───────────────────────────────────────────
BG        = "#f8fafc"   # main canvas — off-white
SIDEBAR   = "#0a0c10"   # sidebar stays deep-black (contrast anchor)
SURFACE   = "#ffffff"   # card / panel — pure white
SURFACE2  = "#f1f5f9"   # slightly raised
BORDER    = "#e2e8f0"   # hairline divider
TXT       = "#0f172a"   # primary text — near-black
TXT2      = "#475569"   # secondary / label
TXT3      = "#94a3b8"   # very muted
WHITE     = "#ffffff"
SUCCESS   = "#15803d"   # deep green (readable on white)
WARNING   = "#b45309"   # amber
DANGER    = "#b91c1c"   # red
BLUE      = "#2563eb"   # primary blue
INDIGO    = "#6366f1"   # indigo
TEAL      = "#0d9488"   # teal
BLUE_HOVER = "#1d4ed8"  # darker blue for hover

# ── Sidebar gradient ──────────────────────────────────────────────────────────
_SB_TOP = (59, 130, 246)   # #3b82f6  bright sky-blue
_SB_BOT = (30,  58, 138)   # #1e3a8a  deep navy


def _lerp_hex(y: int, h: int, lighter: bool = False) -> str:
    t = min(max(y / max(h, 1), 0), 1)
    r = int(_SB_TOP[0] + (_SB_BOT[0] - _SB_TOP[0]) * t)
    g = int(_SB_TOP[1] + (_SB_BOT[1] - _SB_TOP[1]) * t)
    b = int(_SB_TOP[2] + (_SB_BOT[2] - _SB_TOP[2]) * t)
    if lighter:
        r, g, b = min(r + 22, 255), min(g + 18, 255), min(b + 22, 255)
    return f"#{r:02x}{g:02x}{b:02x}"


class Tooltip:
    def __init__(self, widget: tk.BaseWidget, text: str) -> None:
        self._widget = widget
        self._text   = text
        self._win: tk.Toplevel | None = None
        widget.bind("<Enter>",       self._show, add="+")
        widget.bind("<Leave>",       self._hide, add="+")
        widget.bind("<ButtonPress>", self._hide, add="+")

    def _show(self, _=None) -> None:
        if self._win:
            return
        w = self._widget
        self._win = tw = tk.Toplevel(w)
        tw.wm_overrideredirect(True)
        tw.wm_attributes("-topmost", True)
        tw.wm_geometry(f"+{w.winfo_rootx()}+{w.winfo_rooty() + w.winfo_height() + 6}")
        tk.Label(tw, text=self._text, font=(FONT, 11),
                 bg="#1c1f27", fg="#d0d4dc",
                 padx=10, pady=6, justify="left", wraplength=360,
                 relief="flat", bd=0).pack()

    def _hide(self, _=None) -> None:
        if self._win:
            self._win.destroy()
            self._win = None


TASKS = [
    ("Part 1  —  ออกใบกำกับภาษี",          "part1/run",        "sheetName"),
    ("Part 1  —  ค่าบริการเพิ่มเติม",       "part1/servicefee", "sheetName"),
    ("Part 2  —  ออกใบแจ้งหนี้ bulk",       "part2/run",        "sheetName"),
    ("Part 3  —  ออกใบเสร็จค่าปรับ",        "part3/run",        "sheetName"),
    ("Part 4  —  ออกใบลดหนี้ (คืนเครื่อง)", "part4/run",        None),
    ("Part 5  —  Match Statement",          "part5/run",        "sheetName"),
    ("Poll Queue ทันที",                    "poll/now",         None),
    ("ทดสอบ PEAK Connection",               "test/peak",        None),
]

# accent color per card (used as top border stripe)
PART_CARDS = [
    ("part1_tax", "Part 1  ·  ใบกำกับภาษี",        BLUE,    "receipt"),
    ("part3_fee", "Part 3  ·  ค่าปรับ",             WARNING, "statement"),
    ("part1_svc", "Part 1  ·  ค่าบริการเพิ่มเติม",  TEAL,    "sum"),
    ("part2_inv", "Part 2  ·  ใบแจ้งหนี้สัญญาใหม่", INDIGO,  "sum"),
]


def _F(size: int, bold: bool = False) -> ctk.CTkFont:
    return ctk.CTkFont(family=FONT, size=size, weight="bold" if bold else "normal")


class MTechApp(ctk.CTk):
    def __init__(self) -> None:
        super().__init__()
        self.option_add("*Font", f"{{{FONT}}} 13")
        self.title(APP_TITLE)
        self.geometry(APP_SIZE)
        self.minsize(960, 600)
        self.configure(fg_color=BG)

        self.cfg    = config.load()
        self.client = FinFinClient(self.cfg["gas_url"], self.cfg["api_key"])

        self.pages:          dict[str, ctk.CTkFrame] = {}
        self.nav_btns:       dict[str, tk.Button]    = {}
        self.nav_indicators: dict[str, int]           = {}
        self._cur_page:      str                      = ""
        self._sb_canvas:     tk.Canvas | None         = None
        self._sb_status_id:  int                      = 0

        self._build_ui()
        self._show_page("dashboard" if self.cfg["gas_url"] else "settings")
        self.after(400, self._check_conn)

    # ── Scaffold ──────────────────────────────────────────────────────────────

    def _build_ui(self) -> None:
        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)

        # ── Sidebar (gradient canvas) ─────────────────────────────────────────
        SB_W    = 220
        NAV_Y0  = 118   # y of first nav row
        NAV_DY  = 46    # row pitch

        sb = tk.Canvas(self, width=SB_W, highlightthickness=0, bd=0,
                       bg=_lerp_hex(360, 720))
        sb.grid(row=0, column=0, sticky="nsew")
        self._sb_canvas = sb

        def _redraw_sb(event=None) -> None:
            w = sb.winfo_width()  or SB_W
            h = sb.winfo_height() or 720
            sb.delete("bg")
            for y in range(0, h + 2, 2):
                sb.create_line(0, y, w, y + 1,
                               fill=_lerp_hex(y, h), width=2, tags="bg")
            sb.tag_lower("bg")
            if self._sb_status_id:
                sb.coords(self._sb_status_id, 22, h - 26)

        sb.bind("<Configure>", _redraw_sb)
        self.after(80, _redraw_sb)

        # ── Logo ──────────────────────────────────────────────────────────────
        lbg = _lerp_hex(44, 720)
        logo_f = tk.Frame(sb, bg=lbg)
        tk.Label(logo_f, text="MTECH",    font=(FONT, 26, "bold"),
                 bg=lbg, fg=WHITE).pack(anchor="w")
        tk.Label(logo_f, text="ระบบบัญชี", font=(FONT, 11),
                 bg=lbg, fg="#bfdbfe").pack(anchor="w", pady=(2, 0))
        sb.create_window(22, 44, window=logo_f, anchor="w")

        # ── Divider ───────────────────────────────────────────────────────────
        sb.create_line(18, 106, SB_W - 18, 106, fill="#93c5fd", width=1)

        # ── Nav items ─────────────────────────────────────────────────────────
        nav_items = [
            ("dashboard", "Dashboard"),
            ("tasks",     "Tasks"),
            ("settings",  "Settings"),
            ("logs",      "Logs"),
        ]
        for i, (key, label) in enumerate(nav_items):
            y   = NAV_Y0 + i * NAV_DY
            bg  = _lerp_hex(y + NAV_DY // 2, 720)
            hbg = _lerp_hex(y + NAV_DY // 2, 720, lighter=True)

            ind_id = sb.create_rectangle(10, y + 3, 13, y + 39,
                                         fill="", outline="")
            self.nav_indicators[key] = ind_id

            btn = tk.Button(
                sb, text=f"   {label}",
                font=(FONT, 14), bg=bg, fg="#93c5fd",
                activebackground=hbg, activeforeground=WHITE,
                anchor="w", relief="flat", bd=0, cursor="hand2",
                command=lambda k=key: self._show_page(k),
            )
            btn.bind("<Enter>",
                lambda e, b=btn, h=hbg: b.configure(bg=h, fg=WHITE))
            btn.bind("<Leave>",
                lambda e, b=btn, c=bg, k=key:
                    b.configure(bg=c,
                                fg=WHITE if self._cur_page == k else "#93c5fd"))
            sb.create_window(10, y + 3, window=btn, anchor="nw",
                             width=200, height=36)
            self.nav_btns[key] = btn

        # ── Status dot ────────────────────────────────────────────────────────
        sbg = _lerp_hex(690, 720)
        self.status_dot = tk.Label(sb, text="● ตรวจสอบ…",
                                   font=(FONT, 11), bg=sbg, fg="#93c5fd")
        self._sb_status_id = sb.create_window(22, 690, window=self.status_dot,
                                              anchor="w")

        # ── Content ───────────────────────────────────────────────────────────
        self.content = ctk.CTkFrame(self, fg_color=BG, corner_radius=0)
        self.content.grid(row=0, column=1, sticky="nsew")

        self.pages = {
            "dashboard": self._build_dashboard(),
            "tasks":     self._build_tasks(),
            "settings":  self._build_settings(),
            "logs":      self._build_logs(),
        }

    def _show_page(self, key: str) -> None:
        self._cur_page = key
        for k, page in self.pages.items():
            if k == key:
                page.pack(fill="both", expand=True, padx=36, pady=32)
            else:
                page.pack_forget()
        for k, btn in self.nav_btns.items():
            active = k == key
            btn.configure(fg=WHITE if active else "#93c5fd")
            if self._sb_canvas and k in self.nav_indicators:
                self._sb_canvas.itemconfigure(
                    self.nav_indicators[k],
                    fill=WHITE if active else "")
        if key == "dashboard":
            self._refresh_dash()

    # ── Dashboard ─────────────────────────────────────────────────────────────

    def _build_dashboard(self) -> ctk.CTkFrame:
        p = ctk.CTkFrame(self.content, fg_color="transparent")

        # Title row
        top = ctk.CTkFrame(p, fg_color="transparent")
        top.pack(fill="x", pady=(0, 6))
        ctk.CTkLabel(top, text="Dashboard", font=_F(32, True),
                     text_color=TXT).pack(side="left")

        right = ctk.CTkFrame(top, fg_color="transparent")
        right.pack(side="right")
        self.dash_month = ctk.CTkEntry(
            right, placeholder_text="เดือน  เช่น  03.2026", width=210,
            fg_color=SURFACE, border_color=BORDER, text_color=TXT,
            placeholder_text_color=TXT3, font=_F(13),
        )
        self.dash_month.pack(side="left", padx=(0, 10))
        ctk.CTkButton(right, text="Refresh", width=100,
            fg_color=BLUE, hover_color=BLUE_HOVER,
            text_color=WHITE, font=_F(13, True),
            corner_radius=6, command=self._refresh_dash,
        ).pack(side="left")

        self.dash_meta = ctk.CTkLabel(p, text="", anchor="w",
                                      text_color=TXT3, font=_F(11))
        self.dash_meta.pack(fill="x", pady=(0, 20))

        # Cards
        scroll = ctk.CTkScrollableFrame(p, fg_color="transparent",
                                        scrollbar_button_color=SURFACE2,
                                        scrollbar_button_hover_color=BORDER)
        scroll.pack(fill="both", expand=True)

        grid = ctk.CTkFrame(scroll, fg_color="transparent")
        grid.pack(fill="x", pady=(0, 20))
        grid.grid_columnconfigure((0, 1), weight=1, uniform="c")

        self.dash_cards: dict[str, dict] = {}
        for idx, (key, title, accent, sheet_key) in enumerate(PART_CARDS):
            card = self._metric_card(grid, title, accent)
            card["frame"].grid(row=idx // 2, column=idx % 2,
                               sticky="nsew", padx=6, pady=6)
            card["sheet_key"] = sheet_key
            self.dash_cards[key] = card

        # Queue row
        q = self._surface_panel(scroll)
        q.pack(fill="x", pady=(0, 8))
        ctk.CTkLabel(q, text="Queue Status", font=_F(13, True),
                     text_color=TXT2).pack(anchor="w", padx=20, pady=(16, 4))
        self.dash_queue = ctk.CTkLabel(q, text="—", anchor="w",
                                       text_color=TXT2, font=_F(13))
        self.dash_queue.pack(anchor="w", padx=20, pady=(0, 16))

        # Error row
        e = self._surface_panel(scroll)
        e.pack(fill="x")
        ctk.CTkLabel(e, text="Error ล่าสุด", font=_F(13, True),
                     text_color=TXT2).pack(anchor="w", padx=20, pady=(16, 4))
        self.dash_errors = ctk.CTkLabel(e, text="—", anchor="w",
                                        justify="left", text_color=TXT2,
                                        font=_F(12))
        self.dash_errors.pack(anchor="w", padx=20, pady=(0, 16), fill="x")

        return p

    def _surface_panel(self, parent) -> ctk.CTkFrame:
        return ctk.CTkFrame(parent, fg_color=SURFACE,
                            border_color=BORDER, border_width=1,
                            corner_radius=12)

    def _metric_card(self, parent, title: str, accent: str) -> dict:
        frame = ctk.CTkFrame(parent, fg_color=SURFACE,
                             border_color=BORDER, border_width=1,
                             corner_radius=12)
        frame.grid_columnconfigure(0, weight=1)

        # Accent top bar (3 px)
        ctk.CTkFrame(frame, height=3, fg_color=accent,
                     corner_radius=0).grid(row=0, column=0, sticky="ew")

        # Title + sheet name
        top = ctk.CTkFrame(frame, fg_color="transparent")
        top.grid(row=1, column=0, sticky="ew", padx=18, pady=(14, 0))
        top.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(top, text=title, anchor="w",
                     font=_F(12), text_color=TXT2).grid(row=0, column=0, sticky="w")
        self_sheet = ctk.CTkLabel(top, text="", anchor="e",
                                  font=_F(11), text_color=TXT3)
        self_sheet.grid(row=0, column=1, sticky="e")

        # Numbers
        nums = ctk.CTkFrame(frame, fg_color="transparent")
        nums.grid(row=2, column=0, sticky="ew", padx=18, pady=(10, 18))
        nums.grid_columnconfigure((0, 1, 2), weight=1)

        def _num(col, val_color, lbl_txt):
            v = ctk.CTkLabel(nums, text="0",
                             font=_F(30, True), text_color=val_color)
            v.grid(row=0, column=col, pady=(0, 2))
            ctk.CTkLabel(nums, text=lbl_txt,
                         font=_F(10), text_color=TXT3).grid(row=1, column=col)
            return v

        done_v   = _num(0, SUCCESS, "ทำแล้ว")
        queue_v  = _num(1, WARNING, "Queue")
        miss_v   = _num(2, DANGER,  "ยังไม่ออก")

        return {
            "frame": frame, "sheet_lbl": self_sheet,
            "done": done_v, "queued": queue_v, "missing": miss_v,
        }

    def _refresh_dash(self) -> None:
        self.dash_meta.configure(text="กำลังโหลด…")
        month = self.dash_month.get().strip()
        params = {"month": month} if month else {}

        def _t():
            try:
                data = self.client.call("dashboard/refresh", params, timeout=60)
                self.after(0, lambda: self._render_dash(data))
            except NoInternetError:
                self.after(0, self._show_offline)
                self.after(0, lambda: self.dash_meta.configure(text="Offline"))
            except Exception as e:
                self.after(0, lambda: self.dash_meta.configure(text=str(e)))

        threading.Thread(target=_t, daemon=True).start()

    def _render_dash(self, data: dict) -> None:
        self.dash_meta.configure(
            text=f"Updated  {data.get('updatedAt','—')}    Month  {data.get('month','—')}")

        sheets = data.get("sheets", {})
        parts  = data.get("parts",  {})
        for key, card in self.dash_cards.items():
            p    = parts.get(key, {})
            si   = sheets.get(card["sheet_key"], {})
            name = si.get("name", "?")
            if not si.get("found"):
                card["sheet_lbl"].configure(text=f"not found", text_color=DANGER)
            elif p.get("error"):
                card["sheet_lbl"].configure(text=p["error"], text_color=WARNING)
            else:
                card["sheet_lbl"].configure(text=name, text_color=TXT3)
            card["done"].configure(   text=str(p.get("done",    0)))
            card["queued"].configure( text=str(p.get("queued",  0)))
            card["missing"].configure(text=str(p.get("missing", 0)))

        q = data.get("queues", {})
        total = sum(q.values()) if q else 0
        q_text = (f"Invoice  {q.get('invoice',0)}     "
                  f"Receipt  {q.get('receipt',0)}     "
                  f"Late Fee  {q.get('receipt_fee',0)}")
        if total:
            q_text += "    ·  Poll Queue ใน Tasks"
        self.dash_queue.configure(text=q_text,
                                  text_color=WARNING if total else TXT2)

        errs = data.get("errors", [])
        if not errs:
            self.dash_errors.configure(text="No recent errors", text_color=SUCCESS)
        else:
            txt = "\n".join(
                f"{e.get('ts','?')}  [{e.get('part','?')}]  {e.get('inv','?')}  {e.get('msg','')[:90]}"
                for e in errs)
            self.dash_errors.configure(text=txt, text_color=DANGER)

    # ── Tasks ─────────────────────────────────────────────────────────────────

    def _build_tasks(self) -> ctk.CTkFrame:
        p = ctk.CTkFrame(self.content, fg_color="transparent")

        ctk.CTkLabel(p, text="Tasks", font=_F(32, True),
                     text_color=TXT).pack(anchor="w", pady=(0, 4))
        ctk.CTkLabel(p, text="เลือก task แล้วกด Run — คำสั่งส่งตรงไปยัง GAS",
                     font=_F(13), text_color=TXT3).pack(anchor="w", pady=(0, 20))

        # Month bar
        mbar = ctk.CTkFrame(p, fg_color=SURFACE, corner_radius=8,
                            border_color=BORDER, border_width=1)
        mbar.pack(fill="x", pady=(0, 16))
        ctk.CTkLabel(mbar, text="เดือน", font=_F(13), text_color=TXT2,
                     ).pack(side="left", padx=(18, 10), pady=12)
        self.month_entry = ctk.CTkEntry(
            mbar, placeholder_text="03.2026  (ว่าง = เดือนปัจจุบัน)", width=300,
            fg_color=SURFACE2, border_color=BORDER, text_color=TXT,
            placeholder_text_color=TXT3, font=_F(13),
        )
        self.month_entry.pack(side="left", pady=12)
        ctk.CTkLabel(mbar, text="· prefix เติมให้อัตโนมัติ",
                     font=_F(11), text_color=TXT3).pack(side="left", padx=(10, 18))

        # Task list
        scroll = ctk.CTkScrollableFrame(p, fg_color="transparent",
                                        scrollbar_button_color=SURFACE2)
        scroll.pack(fill="both", expand=True)

        for label, action, param in TASKS:
            btn = ctk.CTkButton(
                scroll, text=label, anchor="w", height=48,
                fg_color=SURFACE, hover_color=SURFACE2,
                text_color=TXT, border_color=BORDER, border_width=1,
                font=_F(14), corner_radius=8,
                command=lambda a=action, pk=param, l=label: self._run(a, pk, l),
            )
            btn.pack(fill="x", pady=3)

        # Output
        ctk.CTkLabel(p, text="Output", font=_F(12, True),
                     text_color=TXT2).pack(anchor="w", pady=(16, 6))
        self.task_out = ctk.CTkTextbox(
            p, height=130,
            fg_color=SURFACE, border_color=BORDER, border_width=1,
            text_color=TXT, font=_F(12), corner_radius=8,
        )
        self.task_out.pack(fill="x")
        return p

    # ── Settings ──────────────────────────────────────────────────────────────

    def _build_settings(self) -> ctk.CTkFrame:
        p = ctk.CTkFrame(self.content, fg_color="transparent")

        ctk.CTkLabel(p, text="Settings", font=_F(32, True),
                     text_color=TXT).pack(anchor="w", pady=(0, 20))

        form = ctk.CTkScrollableFrame(p, fg_color="transparent",
                                      scrollbar_button_color=SURFACE2)
        form.pack(fill="both", expand=True)

        self._field(form, "GAS Web App URL", "gas_url",
                    ph="https://script.google.com/macros/s/AKfycb…/exec")
        self._field(form, "API Key", "api_key", ph="shared secret", show="•")

        ctk.CTkFrame(form, height=1, fg_color=BORDER).pack(fill="x", pady=(24, 16))
        row = ctk.CTkFrame(form, fg_color="transparent")
        row.pack(fill="x", pady=(0, 4))
        ctk.CTkLabel(row, text="PEAK Credentials", font=_F(15, True),
                     text_color=TXT).pack(side="left")
        ctk.CTkLabel(row, text="  ·  จะส่งไปเก็บที่ GAS ScriptProperties",
                     font=_F(12), text_color=TXT3).pack(side="left")

        self.e_connect = self._plain_field(form, "CONNECT_ID")
        self.e_token   = self._plain_field(form, "USER_TOKEN", show="•")
        self.e_ss      = self._plain_field(form, "SPREADSHEET_ID")
        self.e_ret     = self._plain_field(form,
            "RETURN_SPREADSHEET_ID  (ว่างได้ ถ้าอยู่ใน Spreadsheet เดียวกัน)")

        btns = ctk.CTkFrame(p, fg_color="transparent")
        btns.pack(fill="x", pady=(18, 0))

        def _white_btn(parent, text, w, cmd):
            return ctk.CTkButton(parent, text=text, width=w,
                fg_color=BLUE, hover_color=BLUE_HOVER,
                text_color=WHITE, font=_F(13, True),
                corner_radius=6, command=cmd)

        b1 = _white_btn(btns, "Save Local", 140, self._save)
        b1.pack(side="left", padx=(0, 10))
        Tooltip(b1, "บันทึก GAS URL และ API Key ลงเครื่องนี้")

        b2 = _white_btn(btns, "Push to GAS", 140, self._push)
        b2.pack(side="left", padx=(0, 10))
        Tooltip(b2, "ส่ง PEAK Credentials ไปเก็บที่ GAS ScriptProperties\n"
                    "(CONNECT_ID / USER_TOKEN / SPREADSHEET_ID)")

        b3 = ctk.CTkButton(btns, text="Test Connection", width=160,
            fg_color=WHITE, hover_color=SURFACE2,
            text_color=TXT, border_color=BORDER, border_width=1,
            font=_F(13), corner_radius=6, command=self._test_conn)
        b3.pack(side="left")
        Tooltip(b3, "ทดสอบว่าเชื่อมต่อ GAS Web App ได้\nต้องกด Save Local ก่อน")

        self.cfg_status = ctk.CTkLabel(p, text="", anchor="w",
                                       font=_F(13))
        self.cfg_status.pack(fill="x", pady=(14, 0))
        return p

    # ── Logs ──────────────────────────────────────────────────────────────────

    def _build_logs(self) -> ctk.CTkFrame:
        p = ctk.CTkFrame(self.content, fg_color="transparent")

        hdr = ctk.CTkFrame(p, fg_color="transparent")
        hdr.pack(fill="x", pady=(0, 16))
        ctk.CTkLabel(hdr, text="Logs", font=_F(32, True),
                     text_color=TXT).pack(side="left")
        ctk.CTkButton(hdr, text="Refresh", width=100,
            fg_color=BLUE, hover_color=BLUE_HOVER,
            text_color=WHITE, font=_F(13, True),
            corner_radius=6, command=self._load_logs,
        ).pack(side="right")

        self.logs_box = ctk.CTkTextbox(
            p, fg_color=SURFACE, border_color=BORDER, border_width=1,
            text_color=TXT2, font=_F(12), corner_radius=8,
        )
        self.logs_box.pack(fill="both", expand=True)
        return p

    # ── Form helpers ──────────────────────────────────────────────────────────

    def _field(self, parent, label, cfg_key, ph="", show=None):
        ctk.CTkLabel(parent, text=label, font=_F(12), text_color=TXT2,
                     ).pack(anchor="w", pady=(12, 4))
        e = ctk.CTkEntry(parent, placeholder_text=ph, show=show, width=640,
                         fg_color=SURFACE, border_color=BORDER, text_color=TXT,
                         placeholder_text_color=TXT3, font=_F(13))
        e.insert(0, self.cfg.get(cfg_key, ""))
        e.pack(fill="x")
        setattr(self, f"_e_{cfg_key}", e)

    def _plain_field(self, parent, label, show=None):
        ctk.CTkLabel(parent, text=label, font=_F(12), text_color=TXT2,
                     ).pack(anchor="w", pady=(12, 4))
        e = ctk.CTkEntry(parent, show=show, width=640,
                         fg_color=SURFACE, border_color=BORDER, text_color=TXT,
                         placeholder_text_color=TXT3, font=_F(13))
        e.pack(fill="x")
        return e

    # ── Actions ───────────────────────────────────────────────────────────────

    def _save(self) -> None:
        self.cfg["gas_url"] = self._e_gas_url.get().strip()
        self.cfg["api_key"] = self._e_api_key.get().strip()
        config.save(self.cfg)
        self.client = FinFinClient(self.cfg["gas_url"], self.cfg["api_key"])
        self._status("✅  บันทึกเรียบร้อย", ok=True)
        self._check_conn()

    def _push(self) -> None:
        self._save()
        params = {k: v for k, v in {
            "CONNECT_ID":            self.e_connect.get().strip(),
            "USER_TOKEN":            self.e_token.get().strip(),
            "SPREADSHEET_ID":        self.e_ss.get().strip(),
            "RETURN_SPREADSHEET_ID": self.e_ret.get().strip(),
        }.items() if v}
        if not params:
            self._status("⚠  ไม่มีค่าให้ส่ง", warn=True)
            return
        def _t():
            try:
                r = self.client.call("config/set", params, timeout=30)
                self._status(f"✅  Push สำเร็จ  ·  {', '.join(r['updated'])}", ok=True)
            except NoInternetError as e:
                self.after(0, self._show_offline)
                self._status(str(e), err=True)
            except Exception as e:
                self._status(str(e), err=True)
        threading.Thread(target=_t, daemon=True).start()

    def _test_conn(self) -> None:
        self._save()
        self._check_conn(verbose=True)

    def _check_conn(self, verbose=False) -> None:
        def _t():
            try:
                self.client.ping()
                self.status_dot.configure(text="● Connected", fg=SUCCESS)
                if verbose:
                    self._status("✅  เชื่อมต่อสำเร็จ", ok=True)
            except NoInternetError:
                self.status_dot.configure(text="● Offline", fg=DANGER)
                if verbose:
                    self.after(0, self._show_offline)
            except Exception as e:
                self.status_dot.configure(text="● Error", fg=WARNING)
                if verbose:
                    self._status(str(e), err=True)
        threading.Thread(target=_t, daemon=True).start()

    def _status(self, msg: str, ok=False, warn=False, err=False) -> None:
        color = SUCCESS if ok else WARNING if warn else DANGER if err else TXT2
        self.after(0, lambda: self.cfg_status.configure(text=msg, text_color=color))

    def _run(self, action: str, param_key: str | None, label: str) -> None:
        params = {}
        if param_key:
            v = self.month_entry.get().strip()
            if v:
                params[param_key] = v
        ts = datetime.now().strftime("%H:%M:%S")
        self.task_out.insert("end", f"[{ts}]  {label}\n")
        self.task_out.see("end")
        def _t():
            try:
                r = self.client.call(action, params)
                self._out(f"        ✓  {self._str(r)}\n")
            except NoInternetError as e:
                self._out(f"        ✗  {e}\n")
                self.after(0, self._show_offline)
            except Exception as e:
                self._out(f"        ✗  {e}\n")
        threading.Thread(target=_t, daemon=True).start()

    def _out(self, t: str) -> None:
        self.task_out.insert("end", t)
        self.task_out.see("end")

    @staticmethod
    def _str(obj) -> str:
        if obj is None:
            return "(no data)"
        if isinstance(obj, (str, int, float, bool)):
            return str(obj)
        if isinstance(obj, dict):
            return "  ·  ".join(f"{k}: {v}" for k, v in obj.items())
        return str(obj)

    def _load_logs(self) -> None:
        def _t():
            try:
                rows = self.client.call("logs/tail", {"limit": 80}, timeout=60)
                self.logs_box.delete("1.0", "end")
                for r in rows:
                    self.logs_box.insert("end",
                        f"{r['ts'][:19]}  [{r['part']}]  {r['sheet']}  "
                        f"row {r['row']}  {r['inv']}  {r['status']}  "
                        f"{r['doc']}  {r['msg']}\n")
            except NoInternetError:
                self.logs_box.insert("end", "Offline\n")
                self.after(0, self._show_offline)
            except Exception as e:
                self.logs_box.insert("end", f"{e}\n")
        threading.Thread(target=_t, daemon=True).start()

    # ── Offline dialog ────────────────────────────────────────────────────────

    def _show_offline(self) -> None:
        d = ctk.CTkToplevel(self)
        d.title("No connection")
        d.geometry("400x220")
        d.resizable(False, False)
        d.grab_set()
        d.transient(self)
        d.configure(fg_color=WHITE)
        self.update_idletasks()
        d.geometry(f"+{self.winfo_rootx()+(self.winfo_width()-400)//2}"
                   f"+{self.winfo_rooty()+(self.winfo_height()-220)//2}")
        ctk.CTkLabel(d, text="No Internet", font=_F(22, True),
                     text_color=TXT).pack(pady=(28, 6))
        ctk.CTkLabel(d, text="กรุณาตรวจสอบ WiFi / สายแลน แล้วลองอีกครั้ง",
                     font=_F(13), text_color=TXT2).pack(pady=(0, 20))
        ctk.CTkButton(d, text="OK", width=120,
            fg_color=BLUE, hover_color=BLUE_HOVER,
            text_color=WHITE, font=_F(13, True),
            corner_radius=6, command=d.destroy).pack()


def main() -> None:
    MTechApp().mainloop()


if __name__ == "__main__":
    main()
