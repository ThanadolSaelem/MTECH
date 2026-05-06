"""
สร้างคู่มือการใช้งาน MTECH ระบบบัญชี FinFin (.docx)
Run: python3.12 generate_manual.py
"""
from __future__ import annotations
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
import copy, os

SS = "/home/user/MTECH/manual_screenshots"
_IMG_EXT = ".jpg"  # use compressed JPEG
OUT = "/home/user/MTECH/คู่มือการใช้งาน_MTECH.docx"

# ── Colour palette ────────────────────────────────────────────────────────────
C_BLUE   = RGBColor(0x25, 0x63, 0xEB)
C_DARK   = RGBColor(0x0f, 0x17, 0x2a)
C_GREY   = RGBColor(0x47, 0x55, 0x69)
C_GREEN  = RGBColor(0x15, 0x80, 0x3d)
C_ORANGE = RGBColor(0xb4, 0x53, 0x09)
C_RED    = RGBColor(0xb9, 0x1c, 0x1c)
C_WHITE  = RGBColor(0xFF, 0xFF, 0xFF)

FONT_TH  = "TH Sarabun New"
FONT_FB  = "Leelawadee UI"   # fallback

# ── Helpers ───────────────────────────────────────────────────────────────────

def _font(run, size_pt: int, bold=False, italic=False,
          color: RGBColor | None = None) -> None:
    run.font.name   = FONT_TH
    run.font.size   = Pt(size_pt)
    run.font.bold   = bold
    run.font.italic = italic
    if color:
        run.font.color.rgb = color
    # fallback font for Thai rendering
    rPr = run._r.get_or_add_rPr()
    rFonts = OxmlElement("w:rFonts")
    rFonts.set(qn("w:ascii"),    FONT_TH)
    rFonts.set(qn("w:hAnsi"),    FONT_TH)
    rFonts.set(qn("w:cs"),       FONT_TH)
    rFonts.set(qn("w:eastAsia"), FONT_TH)
    rPr.insert(0, rFonts)


def _set_para_spacing(para, before_pt=0, after_pt=6) -> None:
    pPr = para._p.get_or_add_pPr()
    spacing = OxmlElement("w:spacing")
    spacing.set(qn("w:before"), str(int(before_pt * 20)))
    spacing.set(qn("w:after"),  str(int(after_pt  * 20)))
    pPr.append(spacing)


def _set_cell_bg(cell, hex_color: str) -> None:
    tc   = cell._tc
    tcPr = tc.get_or_add_tcPr()
    shd  = OxmlElement("w:shd")
    shd.set(qn("w:val"),   "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"),  hex_color)
    tcPr.append(shd)


def _set_col_width(table, col_idx: int, width_cm: float) -> None:
    for row in table.rows:
        row.cells[col_idx].width = Cm(width_cm)


def _no_border_table(table) -> None:
    tbl  = table._tbl
    tblPr = tbl.find(qn("w:tblPr"))
    if tblPr is None:
        tblPr = OxmlElement("w:tblPr")
        tbl.insert(0, tblPr)
    tblBorders = OxmlElement("w:tblBorders")
    for side in ("top","left","bottom","right","insideH","insideV"):
        el = OxmlElement(f"w:{side}")
        el.set(qn("w:val"),   "none")
        el.set(qn("w:sz"),    "0")
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), "auto")
        tblBorders.append(el)
    tblPr.append(tblBorders)


def _set_table_border(table, color_hex="CCCCCC") -> None:
    tbl   = table._tbl
    tblPr = tbl.find(qn("w:tblPr"))
    if tblPr is None:
        tblPr = OxmlElement("w:tblPr")
        tbl.insert(0, tblPr)
    tblBorders = OxmlElement("w:tblBorders")
    for side in ("top","left","bottom","right","insideH","insideV"):
        el = OxmlElement(f"w:{side}")
        el.set(qn("w:val"),   "single")
        el.set(qn("w:sz"),    "4")
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), color_hex)
        tblBorders.append(el)
    tblPr.append(tblBorders)


class Manual:
    def __init__(self) -> None:
        self.doc = Document()
        self._setup_page()

    def _setup_page(self) -> None:
        sec = self.doc.sections[0]
        sec.page_width  = Cm(21)
        sec.page_height = Cm(29.7)
        sec.left_margin = sec.right_margin = Cm(2.5)
        sec.top_margin  = sec.bottom_margin = Cm(2.5)

    # ── Cover ─────────────────────────────────────────────────────────────────
    def cover(self) -> None:
        doc = self.doc
        # top spacer
        for _ in range(6):
            p = doc.add_paragraph()
            _set_para_spacing(p, 0, 0)

        p = doc.add_paragraph()
        r = p.add_run("MTECH ระบบบัญชี")
        _font(r, 36, bold=True, color=C_BLUE)
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER

        p = doc.add_paragraph()
        r = p.add_run("คู่มือการใช้งานสำหรับเจ้าหน้าที่")
        _font(r, 20, color=C_DARK)
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER

        p = doc.add_paragraph()
        r = p.add_run("FinFin — ระบบออกเอกสารบัญชีอัตโนมัติ")
        _font(r, 14, color=C_GREY)
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER

        for _ in range(2):
            p = doc.add_paragraph()
            _set_para_spacing(p, 0, 0)

        # meta table
        tbl = doc.add_table(rows=3, cols=2)
        _no_border_table(tbl)
        meta = [("เวอร์ชัน", "1.0"), ("อัปเดตล่าสุด", "พฤษภาคม 2569"),
                ("สำหรับ", "พี่นก · ชะเอม")]
        for i, (k, v) in enumerate(meta):
            rc = tbl.rows[i].cells
            _set_cell_bg(rc[0], "EFF6FF")
            _set_cell_bg(rc[1], "EFF6FF")
            rk = rc[0].paragraphs[0].add_run(k)
            _font(rk, 13, bold=True, color=C_BLUE)
            rv = rc[1].paragraphs[0].add_run(v)
            _font(rv, 13, color=C_DARK)
        tbl.alignment = WD_TABLE_ALIGNMENT.CENTER

        doc.add_page_break()

    # ── Chapter / Section headings ────────────────────────────────────────────
    def h1(self, text: str) -> None:
        p = self.doc.add_paragraph()
        r = p.add_run(text)
        _font(r, 18, bold=True, color=C_BLUE)
        _set_para_spacing(p, 18, 8)

    def h2(self, text: str) -> None:
        p = self.doc.add_paragraph()
        r = p.add_run(text)
        _font(r, 14, bold=True, color=C_DARK)
        _set_para_spacing(p, 10, 4)

    def body(self, text: str, bold=False, color: RGBColor | None = None) -> None:
        p = self.doc.add_paragraph()
        r = p.add_run(text)
        _font(r, 13, bold=bold, color=color or C_DARK)
        _set_para_spacing(p, 0, 4)

    def spacer(self, n=1) -> None:
        for _ in range(n):
            p = self.doc.add_paragraph()
            _set_para_spacing(p, 0, 0)

    # ── Callout box ───────────────────────────────────────────────────────────
    def callout(self, emoji: str, text: str, bg="EFF6FF") -> None:
        tbl = self.doc.add_table(rows=1, cols=1)
        _set_table_border(tbl, "BFDBFE")
        cell = tbl.rows[0].cells[0]
        _set_cell_bg(cell, bg)
        p = cell.paragraphs[0]
        r = p.add_run(f"{emoji}  {text}")
        _font(r, 13, color=C_DARK)
        p.paragraph_format.space_before = Pt(4)
        p.paragraph_format.space_after  = Pt(4)
        self.spacer()

    # ── Numbered step table ───────────────────────────────────────────────────
    def steps(self, items: list[tuple[str, str]]) -> None:
        tbl = self.doc.add_table(rows=len(items), cols=2)
        _no_border_table(tbl)
        for i, (num, desc) in enumerate(items):
            cells = tbl.rows[i].cells
            cells[0].width = Cm(1.2)
            cells[1].width = Cm(13.8)
            _set_cell_bg(cells[0], "DBEAFE")
            rn = cells[0].paragraphs[0].add_run(num)
            _font(rn, 14, bold=True, color=C_BLUE)
            cells[0].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
            cells[0].vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            rd = cells[1].paragraphs[0].add_run(desc)
            _font(rd, 13, color=C_DARK)
        self.spacer()

    # ── Data table ────────────────────────────────────────────────────────────
    def table(self, headers: list[str], rows: list[list[str]],
              col_widths: list[float] | None = None) -> None:
        tbl = self.doc.add_table(rows=1 + len(rows), cols=len(headers))
        _set_table_border(tbl, "CBD5E1")

        # header row
        hr = tbl.rows[0]
        for j, h in enumerate(headers):
            _set_cell_bg(hr.cells[j], "1E3A8A")
            r = hr.cells[j].paragraphs[0].add_run(h)
            _font(r, 12, bold=True, color=C_WHITE)
            hr.cells[j].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER

        # data rows
        for i, row in enumerate(rows):
            bg = "F8FAFC" if i % 2 == 0 else "EFF6FF"
            for j, val in enumerate(row):
                _set_cell_bg(tbl.rows[i + 1].cells[j], bg)
                r = tbl.rows[i + 1].cells[j].paragraphs[0].add_run(val)
                _font(r, 12, color=C_DARK)

        if col_widths:
            for j, w in enumerate(col_widths):
                _set_col_width(tbl, j, w)
        self.spacer()

    # ── Image ─────────────────────────────────────────────────────────────────
    def image(self, path: str, caption: str = "", width_cm=14.0) -> None:
        if not os.path.exists(path):
            self.body(f"[ภาพ: {path} ไม่พบไฟล์]", color=C_RED)
            return
        self.doc.add_picture(path, width=Cm(width_cm))
        last = self.doc.paragraphs[-1]
        last.alignment = WD_ALIGN_PARAGRAPH.CENTER
        if caption:
            p = self.doc.add_paragraph()
            r = p.add_run(caption)
            _font(r, 11, italic=True, color=C_GREY)
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        self.spacer()

    # ── Build all chapters ────────────────────────────────────────────────────
    def build(self) -> None:
        self.cover()
        self._ch1()
        self._ch2()
        self._ch3()
        self._ch4()
        self._ch5()
        self._ch6()
        self._ch7()
        self._ch8()

    # ─────────────────────────────────────────────────────────────────────────
    # บทที่ 1 — ภาพรวมระบบ
    # ─────────────────────────────────────────────────────────────────────────
    def _ch1(self) -> None:
        self.h1("บทที่ 1   ภาพรวมระบบ")

        self.h2("1.1  วัตถุประสงค์")
        self.body(
            "ระบบ MTECH ระบบบัญชี พัฒนาขึ้นเพื่อให้เจ้าหน้าที่สามารถออกเอกสารบัญชีผ่าน PEAK "
            "ได้อย่างอัตโนมัติ แทนที่กระบวนการทำด้วยมือที่ใช้เวลานานและเสี่ยงต่อข้อผิดพลาด"
        )
        self.spacer()

        self.table(
            ["ก่อนใช้ระบบ", "", "หลังใช้ระบบ"],
            [
                ["เปิดใบกำกับภาษีทีละใบใน SME Move", "→", "ออกใบกำกับภาษี bulk อัตโนมัติ ~800 ใบ/เดือน"],
                ["แก้วันที่ทีละใบ (~ครึ่งวัน/เดือน)",  "→", "Date Logic คำนวณให้อัตโนมัติ"],
                ["Upload Excel Template ทีละชุด",       "→", "ส่ง PEAK API ตรง ไม่ต้องแตะ Excel"],
                ["เปิดใบเสร็จค่าปรับทีละใบ >100 ใบ",   "→", "รันคำสั่งเดียว ครบทุกรายการ"],
            ],
            col_widths=[6.5, 0.8, 6.5],
        )

        self.h2("1.2  เอกสารที่ระบบออกให้")
        self.table(
            ["ส่วน", "ชื่องาน", "เอกสารที่ออก", "จำนวน/เดือน"],
            [
                ["Part 1", "ออกใบกำกับภาษี",     "ใบกำกับภาษี / ใบเสร็จรับเงิน",  "~800 ใบ"],
                ["Part 1", "ค่าบริการเพิ่มเติม",  "ใบกำกับภาษีค่าบริการ",           "ตามจริง"],
                ["Part 2", "ออกใบแจ้งหนี้ bulk",  "ใบแจ้งหนี้ + แตกงวดรับชำระ",    "ตามสัญญาใหม่"],
                ["Part 3", "ออกใบเสร็จค่าปรับ",   "ใบเสร็จรับเงินค่าปรับ (ไม่มี VAT)", "~100+ ใบ"],
                ["Part 4", "ออกใบลดหนี้ (คืนเครื่อง)", "ใบลดหนี้",              "ตามจริง"],
                ["Part 5", "Match Statement",     "รายงาน Match SCB ↔ Receipt",   "ทุกเดือน"],
            ],
            col_widths=[1.5, 4.0, 5.5, 2.8],
        )
        self.doc.add_page_break()

    # ─────────────────────────────────────────────────────────────────────────
    # บทที่ 2 — การติดตั้งโปรแกรม
    # ─────────────────────────────────────────────────────────────────────────
    def _ch2(self) -> None:
        self.h1("บทที่ 2   การติดตั้งโปรแกรม")

        self.h2("2.1  ความต้องการของระบบ")
        self.table(
            ["รายการ", "ข้อกำหนด"],
            [
                ["ระบบปฏิบัติการ", "Windows 10 / Windows 11"],
                ["การเชื่อมต่ออินเทอร์เน็ต", "จำเป็น — ใช้ส่งคำสั่งไปยัง GAS และ PEAK"],
                ["ไฟล์ติดตั้ง",  "MTECH_Setup.exe (รับจากทีม MTECH)"],
                ["พื้นที่จัดเก็บ", "~100 MB"],
            ],
            col_widths=[5.0, 9.0],
        )

        self.h2("2.2  วิธีติดตั้ง")
        self.steps([
            ("1", "ดับเบิลคลิกที่ไฟล์ MTECH_Setup.exe ที่ได้รับมา"),
            ("2", "กด Next และ Install ตามขั้นตอน → รอให้ติดตั้งเสร็จ"),
            ("3", "กด Finish — โปรแกรมจะเปิดขึ้นอัตโนมัติ"),
            ("4", "ครั้งแรกที่เปิด ระบบจะพาไปที่หน้า Settings เพื่อตั้งค่า (ดูบทที่ 3)"),
        ])
        self.callout("💡", "ไม่จำเป็นต้องมีสิทธิ์ Administrator — ติดตั้งในโฟลเดอร์ของผู้ใช้ปัจจุบันได้เลย")
        self.doc.add_page_break()

    # ─────────────────────────────────────────────────────────────────────────
    # บทที่ 3 — การตั้งค่าครั้งแรก
    # ─────────────────────────────────────────────────────────────────────────
    def _ch3(self) -> None:
        self.h1("บทที่ 3   การตั้งค่าครั้งแรก")
        self.callout("💡",
            "ขั้นตอนนี้ทำเพียงครั้งเดียว — เมื่อตั้งค่าแล้วไม่ต้องทำซ้ำ "
            "เว้นแต่มีการเปลี่ยน GAS หรือ PEAK credentials")

        self.image(f"{SS}/ss_settings{_IMG_EXT}", "หน้า Settings — กรอกข้อมูลเชื่อมต่อ")

        self.h2("3.1  กรอก GAS Web App URL และ API Key")
        self.body("ข้อมูลนี้รับจากทีม MTECH — ใส่แล้วกด Save Local เพื่อบันทึกลงเครื่อง")
        self.steps([
            ("1", "กรอก GAS Web App URL ในช่องแรก\nตัวอย่าง: https://script.google.com/macros/s/AKfycb…/exec"),
            ("2", "กรอก API Key ในช่องที่สอง (ตัวอักษรที่พิมพ์จะแสดงเป็น •••••)"),
            ("3", "กดปุ่ม Save Local — ระบบแสดง ✅ บันทึกเรียบร้อย"),
        ])

        self.h2("3.2  กรอก PEAK Credentials")
        self.body(
            "ข้อมูลส่วนนี้รับจากทีม PEAK หลังสมัครใช้งาน API — "
            "เมื่อกรอกแล้วกด Push to GAS เพื่อส่งไปเก็บที่ระบบ GAS"
        )
        self.table(
            ["ช่อง", "คำอธิบาย"],
            [
                ["CONNECT_ID",            "รหัสเชื่อมต่อ PEAK (รับจาก Email ของ PEAK)"],
                ["USER_TOKEN",            "รหัสผ่าน API (สร้างจากหน้า PEAK โดยใช้ Application Code)"],
                ["SPREADSHEET_ID",        "ID ของ Google Sheet หลัก (ดูจาก URL ของ Sheet)"],
                ["RETURN_SPREADSHEET_ID", "ID ของ Sheet ไฟล์รับคืน (ว่างได้ถ้าอยู่ใน Sheet เดียวกัน)"],
            ],
            col_widths=[4.5, 9.5],
        )
        self.steps([
            ("1", "กรอก CONNECT_ID, USER_TOKEN, SPREADSHEET_ID ให้ครบ"),
            ("2", "กดปุ่ม Push to GAS — ระบบแสดง ✅ Push สำเร็จ"),
        ])
        self.callout("⚠️",
            "USER_TOKEN มีอายุ — หากระบบแจ้ง error เรื่อง token ให้ขอ User Token ใหม่จาก PEAK "
            "แล้ว Push to GAS อีกครั้ง")

        self.h2("3.3  ทดสอบการเชื่อมต่อ")
        self.steps([
            ("1", "กดปุ่ม Test Connection"),
            ("2", "รอสักครู่ — ถ้าเชื่อมต่อสำเร็จจะแสดง ✅ เชื่อมต่อสำเร็จ"),
            ("3", "แถบสถานะด้านซ้ายล่างจะเปลี่ยนเป็น ● Connected (สีเขียว)"),
        ])
        self.doc.add_page_break()

    # ─────────────────────────────────────────────────────────────────────────
    # บทที่ 4 — หน้า Dashboard
    # ─────────────────────────────────────────────────────────────────────────
    def _ch4(self) -> None:
        self.h1("บทที่ 4   หน้า Dashboard")
        self.body("หน้า Dashboard แสดงภาพรวมสถานะงานประจำเดือน — ใช้ตรวจสอบว่าแต่ละ Part ทำเสร็จแล้วหรือยัง")
        self.image(f"{SS}/ss_dashboard{_IMG_EXT}", "หน้า Dashboard — ภาพรวมสถานะงาน")

        self.h2("4.1  การ์ดสถิติ 4 ใบ")
        self.body("แต่ละการ์ดแสดงตัวเลข 3 ค่า สีต่างกัน:")
        self.table(
            ["ตัวเลข", "สี", "ความหมาย"],
            [
                ["ทำแล้ว",     "เขียว", "รายการที่ออกเอกสารใน PEAK สำเร็จแล้ว"],
                ["Queue",      "ส้ม",   "รายการที่ส่ง PEAK แล้ว แต่ยังรอผลลัพธ์"],
                ["ยังไม่ออก",  "แดง",   "รายการที่ยังไม่ได้ออกเอกสาร (ต้องรัน Task)"],
            ],
            col_widths=[2.5, 2.0, 9.5],
        )

        self.h2("4.2  วิธีเลือกเดือนและ Refresh")
        self.steps([
            ("1", "พิมพ์เดือนในช่อง เช่น 05.2026 (รูปแบบ MM.YYYY)"),
            ("2", "กดปุ่ม Refresh — ตัวเลขจะอัปเดตตามเดือนที่เลือก"),
            ("3", "ถ้าปล่อยว่าง ระบบจะดึงข้อมูลเดือนปัจจุบัน"),
        ])

        self.h2("4.3  Queue Status และ Error ล่าสุด")
        self.body(
            "Queue Status แสดงจำนวนรายการที่รอผลลัพธ์จาก PEAK — "
            "ถ้ามีค่า > 0 ให้ไปที่หน้า Tasks แล้วกด Poll Queue ทันที"
        )
        self.callout("📌",
            "Error ล่าสุด — ถ้าแสดง \"No recent errors\" (สีเขียว) แสดงว่าระบบทำงานปกติ "
            "ถ้ามีรายการ error ให้ตรวจสอบที่หน้า Logs")
        self.doc.add_page_break()

    # ─────────────────────────────────────────────────────────────────────────
    # บทที่ 5 — หน้า Tasks
    # ─────────────────────────────────────────────────────────────────────────
    def _ch5(self) -> None:
        self.h1("บทที่ 5   หน้า Tasks (การรันงาน)")
        self.body(
            "หน้า Tasks คือศูนย์กลางการรันงานทั้งหมด — เลือก task ที่ต้องการ "
            "ใส่เดือน แล้วกดปุ่มนั้น ระบบจะส่งคำสั่งไปยัง GAS ทันที"
        )
        self.image(f"{SS}/ss_tasks{_IMG_EXT}", "หน้า Tasks — รายการงานทั้งหมด")

        self.h2("5.1  วิธีใช้งานทั่วไป")
        self.steps([
            ("1", "พิมพ์เดือนในช่อง เดือน เช่น 05.2026\n"
                  "· ปล่อยว่างได้ถ้าต้องการเดือนปัจจุบัน\n"
                  "· ไม่ต้องพิมพ์ prefix เช่น Receipt — ระบบเติมให้อัตโนมัติ"),
            ("2", "กดปุ่ม task ที่ต้องการรัน"),
            ("3", "รอดูผลใน Output box ด้านล่าง\n"
                  "  ✓ สีเขียว = สำเร็จ\n"
                  "  ✗ สีแดง = มีข้อผิดพลาด (ดูรายละเอียดในหน้า Logs)"),
        ])
        self.callout("⚠️",
            "อย่ากดปุ่มซ้ำในขณะที่กำลังรันอยู่ — ระบบมีการป้องกัน duplicate "
            "แต่การกดซ้ำอาจทำให้ output สับสน")

        self.h2("5.2  ตารางสรุป Tasks ทั้งหมด")
        self.table(
            ["ปุ่ม", "ใช้เมื่อ", "ต้องใส่เดือน", "หมายเหตุ"],
            [
                ["Part 1 — ออกใบกำกับภาษี",      "ต้นเดือน หลังรวบรวม Receipt ครบ",        "✅", "งานหลัก ~800 ใบ/เดือน"],
                ["Part 1 — ค่าบริการเพิ่มเติม",   "มีค่าบริการพิเศษ เช่น ค่าปลดล็อก",      "✅", ""],
                ["Part 2 — ออกใบแจ้งหนี้ bulk",   "มีสัญญาใหม่ในเดือนนั้น",                "✅", "ทำครั้งเดียวต่อเดือน"],
                ["Part 3 — ออกใบเสร็จค่าปรับ",    "มีรายการค่าปรับในชีต",                   "✅", "~100+ ใบ/เดือน"],
                ["Part 4 — ออกใบลดหนี้",          "มีการคืนเครื่อง",                        "❌", "ดึงข้อมูลจากไฟล์รับคืน"],
                ["Part 5 — Match Statement",      "หลัง Download Statement SCB",            "✅", "ใส่ชื่อชีต 2 ชีต"],
                ["Poll Queue ทันที",              "หลัง Part 1/2/3 มีตัวเลข Queue > 0",     "❌", "รับเลขที่เอกสารจาก PEAK"],
                ["ทดสอบ PEAK Connection",         "เมื่อสงสัยว่า PEAK ใช้งานได้หรือไม่",    "❌", ""],
            ],
            col_widths=[4.2, 4.8, 2.2, 2.8],
        )

        self.h2("5.3  Part 5 — Match Statement (พิเศษ)")
        self.body(
            "Part 5 ต้องการชีต 2 ชีต — ระบบจะถามชื่อชีตในช่อง เดือน "
            "โดย prefix จะเติมให้อัตโนมัติ:"
        )
        self.table(
            ["ช่อง", "พิมพ์", "ระบบจะหาชีต"],
            [
                ["Statement Sheet", "05.2026", "SCB05.2026"],
                ["Receipt Sheet",   "05.2026", "Receipt05.2026"],
            ],
            col_widths=[3.5, 3.5, 7.0],
        )
        self.doc.add_page_break()

    # ─────────────────────────────────────────────────────────────────────────
    # บทที่ 6 — หน้า Logs
    # ─────────────────────────────────────────────────────────────────────────
    def _ch6(self) -> None:
        self.h1("บทที่ 6   หน้า Logs")
        self.body(
            "หน้า Logs แสดงประวัติการทำงานของระบบ 80 แถวล่าสุด — "
            "ใช้ตรวจสอบเมื่อมี error หรือต้องการดู document number ที่ออกไป"
        )
        self.image(f"{SS}/ss_logs{_IMG_EXT}", "หน้า Logs — บันทึกการทำงาน")

        self.h2("6.1  วิธีดู Log")
        self.steps([
            ("1", "กดปุ่ม Refresh เพื่อโหลด log ล่าสุด"),
            ("2", "อ่านรายการจากบนลงล่าง — แถวล่างสุดคือรายการล่าสุด"),
        ])

        self.h2("6.2  ความหมายของแต่ละคอลัมน์ใน Log")
        self.table(
            ["คอลัมน์", "ตัวอย่าง", "ความหมาย"],
            [
                ["เวลา",   "2026-05-06 10:30:00", "วันและเวลาที่รัน"],
                ["part",   "part1",               "งานที่รัน"],
                ["sheet",  "Receipt05.2026",       "ชีตที่ประมวลผล"],
                ["row",    "row 5",                "แถวใน Sheet"],
                ["inv",    "INV-0001",             "เลขที่สัญญา"],
                ["status", "ok / error",           "ผลลัพธ์"],
                ["doc",    "TAX-0001",             "เลขที่เอกสารใน PEAK"],
                ["msg",    "ข้อความ error",         "รายละเอียดเพิ่มเติม"],
            ],
            col_widths=[2.5, 4.0, 7.5],
        )
        self.doc.add_page_break()

    # ─────────────────────────────────────────────────────────────────────────
    # บทที่ 7 — ปัญหาที่พบบ่อย
    # ─────────────────────────────────────────────────────────────────────────
    def _ch7(self) -> None:
        self.h1("บทที่ 7   ปัญหาที่พบบ่อยและการแก้ไข")

        self.table(
            ["อาการที่พบ", "สาเหตุ", "วิธีแก้ไข"],
            [
                ["Output แสดง \"ยังไม่ได้ตั้งค่า GAS URL\"",
                 "ยังไม่ได้กรอก GAS URL",
                 "ไปหน้า Settings → กรอก GAS URL → Save Local"],
                ["ไดอะล็อก \"No Internet\" ขึ้นมา",
                 "ไม่มีการเชื่อมต่ออินเทอร์เน็ต",
                 "ตรวจสอบ WiFi / สายแลน แล้วลองใหม่"],
                ["Output แสดง \"หมดเวลา (300s)\"",
                 "งานเยอะ GAS ใช้เวลานาน",
                 "รอให้ครบแล้วกด Poll Queue ทันที"],
                ["ตัวเลขใน Dashboard ไม่เปลี่ยน",
                 "ยังแสดงข้อมูลเดิม",
                 "กด Refresh หรือเลือกเดือนใหม่"],
                ["Output แสดง \"✗ PEAK API error\"",
                 "Credentials ผิดหรือหมดอายุ",
                 "ไปหน้า Settings → อัปเดต USER_TOKEN → Push to GAS"],
                ["สถานะซ้ายล่างแสดง ● Offline",
                 "เชื่อมต่อ GAS ไม่ได้",
                 "ตรวจอินเทอร์เน็ต แล้วกด Test Connection"],
                ["แถวใน Sheet แสดง PROCESSING ค้างนาน",
                 "GAS timeout ระหว่างรัน",
                 "กด Poll Queue — ระบบจะ update เลขเอกสาร"],
                ["ออกใบซ้ำ",
                 "กดปุ่มซ้ำขณะรัน",
                 "ระบบป้องกัน duplicate อัตโนมัติ — ตรวจคอลัมน์ผลใน Sheet"],
            ],
            col_widths=[4.5, 4.0, 5.5],
        )
        self.doc.add_page_break()

    # ─────────────────────────────────────────────────────────────────────────
    # บทที่ 8 — ข้อมูลอ้างอิง
    # ─────────────────────────────────────────────────────────────────────────
    def _ch8(self) -> None:
        self.h1("บทที่ 8   ข้อมูลอ้างอิง")

        self.h2("8.1  สัญลักษณ์สถานะในโปรแกรม")
        self.table(
            ["สัญลักษณ์", "ความหมาย"],
            [
                ["● Connected (เขียว)",   "เชื่อมต่อ GAS สำเร็จ — พร้อมใช้งาน"],
                ["● Offline (แดง)",       "เชื่อมต่อไม่ได้ — ตรวจอินเทอร์เน็ต"],
                ["● Error (แดง)",         "เชื่อมต่อได้แต่ GAS ตอบ error"],
                ["● ตรวจสอบ… (เทา)",     "กำลังทดสอบการเชื่อมต่ออยู่"],
                ["✓ (เขียว ใน Output)",   "Task รันสำเร็จ"],
                ["✗ (แดง ใน Output)",     "Task ล้มเหลว — ดู Logs สำหรับรายละเอียด"],
            ],
            col_widths=[4.5, 9.5],
        )

        self.h2("8.2  ผู้ดูแลระบบ (ติดต่อเมื่อต้องการความช่วยเหลือ)")
        self.callout("📌",
            "หากพบปัญหาที่ไม่สามารถแก้ไขได้ด้วยตนเอง กรุณาติดต่อทีม MTECH "
            "พร้อมแจ้ง: อาการที่พบ, หน้าจอ Error ล่าสุดใน Logs, และเดือนที่มีปัญหา")


def main() -> None:
    m = Manual()
    m.build()
    m.doc.save(OUT)
    print(f"✅ บันทึกไฟล์: {OUT}")


if __name__ == "__main__":
    main()
