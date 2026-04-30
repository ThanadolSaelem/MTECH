---
name: FinFin Full Project Context (2026-05-01)
description: สถานะโปรเจกต์ครบถ้วน — คอดที่แก้ล่าสุด, โครงสร้าง Sheet, pending tasks, business rules ทั้งหมด เทียบเท่า compact
type: project
originSessionId: 6bb74dd4-e0bb-4549-acb8-c4b2474d8a1c
---
## ภาพรวม

**ลูกค้า:** FinFin (ขายผ่อนมือถือ) — พี่นก (PenpimNok) บัญชี, ชะเอม (กรอก Sheet), คุณสุนทร (โค้ช)
**เป้าหมาย:** แทน SME Move ด้วย GAS + PEAK API — ออกเอกสารบัญชีอัตโนมัติ ~800 ใบ/เดือน
**Deadline:** ก่อน 2026-05-31
**Working directory:** `C:\Users\Mynew\Desktop\ระบบบัญชี\`
**Google Sheet:** https://docs.google.com/spreadsheets/d/123EwnVGDbuaBg0HTsZhpdX8EgKvfa7nja9ngfenN5Zo/edit

---

## สถานะปัจจุบัน (2026-05-01)

| Part | หน้าที่ | สถานะ |
|------|---------|--------|
| Part 1 | ออกใบกำกับภาษี bulk + Date Logic | ✅ โค้ดครบ ⏳ รอ PEAK creds |
| Part 1-svc | ออกใบกำกับภาษีค่าบริการเพิ่มเติม | ✅ โค้ดครบ ⏳ รอ PEAK creds |
| Part 2 | ออกใบแจ้งหนี้ + แตกงวดอัตโนมัติ | ✅ โค้ดครบ ⏳ รอ PEAK creds |
| Part 3 | ออกใบเสร็จค่าปรับ bulk (ไม่มี VAT) | ✅ โค้ดครบ ⏳ รอ PEAK creds |
| Part 4 | ออกใบลดหนี้ (คืนเครื่อง) | ✅ โค้ดครบ ⏳ รอ PEAK creds |
| Part 5 | Match Statement SCB กับ Receipt | ✅ **ทดสอบแล้ว** 681✓ 205⚠️ 119✗ |
| Desktop Client | Python CTk GUI (main.py) | ✅ ทำงานได้ Tesla light theme |
| Installer | MTECH_Setup.exe (Inno Setup) | ✅ ไฟล์พร้อม ต้อง rebuild หลัง edit UI |

**⏳ Blocker หลัก:** PEAK credentials (CONNECT_ID + USER_TOKEN) ยังไม่ได้รับ → test Parts 1-4 ไม่ได้

---

## GAS Files (`C:\Users\Mynew\Desktop\ระบบบัญชี\`)

| File | หน้าที่ | หมายเหตุ |
|------|---------|----------|
| `00_Config.gs` | Config ทั้งหมด | ✅ แก้แล้ว: `RECEIPT_HEADER_ROW:2`, `STATEMENT_FORMAT_ENHANCED.HEADER_ROW:6` |
| `01_Auth.gs` | HMAC-SHA1, Client Token cache | |
| `02_Utils.gs` | Date/number helpers, log, queue | |
| `03_Part1_TaxInvoice.gs` | ออกใบกำกับภาษี bulk | Date Logic Case A/B |
| `04_Part2_Invoice.gs` | ออกใบแจ้งหนี้ + แตกงวด | |
| `05_Part3_LateFee.gs` | ออกใบเสร็จค่าปรับ | ไม่มี VAT |
| `06_Part4_CreditNote.gs` | ออกใบลดหนี้ | |
| `07_PollResults.gs` | Poll PEAK queue | |
| `08_Menu.gs` | UI Menu + Time Trigger | |
| `09_Dashboard.gs` | ✅ แก้แล้ว | รับ `monthOverride` param ได้แล้ว |
| `11_WebApp.gs` | ✅ แก้แล้ว | มี `resolveSheet_()` auto-prefix + router ครบ |

### การแก้ไขล่าสุดใน `00_Config.gs`
```javascript
RECEIPT_HEADER_ROW: 2,      // row1=summary, row2=headers, row3+=data
STATEMENT_FORMAT_ENHANCED: { HEADER_ROW: 6, ... }  // rows1-5 metadata, row6=headers
```

### `resolveSheet_()` ใน `11_WebApp.gs`
```javascript
function resolveSheet_(name, prefix) {
  if (!name || !String(name).trim()) return null;
  const s = String(name).trim();
  if (s.startsWith(prefix)) return s;
  return `${prefix}${s}`;
}
// User พิมพ์ "03.2026" → ระบบเติม prefix อัตโนมัติ → "Receipt03.2026"
```

### Router actions ที่รองรับ (11_WebApp.gs)
- `dashboard/refresh` (รับ `month` param)
- `part1/run`, `part1/servicefee`, `part2/run`, `part3/run`, `part4/run`
- `part5/run` (รับ `statementSheetName` + `receiptSheetName`)
- `poll/now`, `test/peak`, `config/set`, `logs/tail`, `ping`

---

## Desktop Client (`finfin_client\`)

### Stack
- Python + CustomTkinter (CTk), Light appearance mode
- Entry point: `main.py` → class `MTechApp`
- Config: `%APPDATA%\FinFin\config.json` (gas_url, api_key)
- HTTP: `api.py` → `FinFinClient.call(action, params)`

### ธีมปัจจุบัน (Tesla Light)
```python
BG="#f8fafc"       # off-white canvas
SIDEBAR=None       # ← แทนด้วย tk.Canvas gradient (ดูด้านล่าง)
SURFACE="#ffffff"  # card/panel
BORDER="#e2e8f0"
TXT="#0f172a"      # near-black primary text
BLUE="#2563eb"     # CTA buttons
```

### Gradient Sidebar
- Sidebar = `tk.Canvas` วาด vertical gradient: `#3b82f6` (top) → `#1e3a8a` (bottom)
- Nav buttons = `tk.Button` (ไม่ใช่ CTkButton) → `bg` match gradient ณ y position นั้น
- Indicator bars = canvas rectangle items (ไม่ใช่ CTkFrame)
- `self._sb_canvas`, `self._cur_page`, `self.nav_indicators: dict[str, int]`
- `_lerp_hex(y, h, lighter=False)` — module-level function คำนวณสี gradient

### Pages
- **Dashboard**: metric cards 4 ใบ (Part1/3/1svc/2), Queue status, Error ล่าสุด, month picker
- **Tasks**: month entry (auto-prefix), list ปุ่ม 8 tasks, output textbox
- **Settings**: GAS URL, API Key (local), PEAK creds (push to GAS), Test Connection
- **Logs**: tail 80 rows จาก GAS

### Installer (`installer.iss`)
```ini
AppName="MTECH ระบบบัญชี"
OutputBaseFilename=MTECH_Setup
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\MTECH
```
Build: `python -m PyInstaller --onefile --windowed --name FinFin main.py`
Installer: `& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer.iss`

---

## โครงสร้าง Sheet จริง (มี.ค. 2026 = format ล่าสุด)

### `Receipt03.2026` — source of truth สำหรับ Part 1
Header **แถว 2**. Columns (1-indexed):
1. เลขที่สัญญา | 2. วันที่ครบกำหนด | 3. ประเภทการชำระ | 4. วันที่รับชำระ | 5. วันที่เปิดใบกำกับภาษี | 6. ใบเสร็จรับเงิน (IVF-) | 7. ชื่อลูกค้า | 8. ยอดเงินรวม

### `Sum03.2026` — สัญญา/ใบแจ้งหนี้ (Part 2)
Header **แถว 2**:
1.ลำดับ | 2.วันที่ทำสัญญา | 3.เลขที่สัญญา | 4.คำนำหน้า | 5.ชื่อลูกค้า | 6.ยอดทำสัญญา | 7.จำนวนงวด | 8.ผ่อนงวดละ | 9.จ่ายทุกวันที่ | 10.สาขา | 11.ลูกหนี้ต้นงวด | 12.เงินดาวน์/ค่างวด | 13.ค่าปรับ | **14.ค่าบริการ** | 15.ส่วนลดปิดยอด | 16.ลูกหนี้ปลายงวด | 17.วันที่ครบกำหนด

### `SCB03.2026` — Bank Statement
Header **แถว 6** (rows 1-5 = metadata). Columns (0-indexed):
0:วัน | 1:เวลา | 2:ยอดเงินเข้า | 3:รายละเอียด(auto) | 4:Note(INV) | 5:เลขที่สัญญา | 7:งวด | 10:ค่าปรับ | 11:วันที่รับเงิน

⚠️ **ต่างจาก CONFIG.STATEMENT_COL เดิมมาก** — เมื่อได้ green light จาก พี่นก ต้อง rewrite column mapping

---

## Business Rules สำคัญ

### Date Logic ใบกำกับภาษี (Part 1) — ห้ามผิด
```
payDate = วันรับชำระจริง (จาก Receipt sheet)

IF payDate < dueDate:
  → /receipts/allinone (TaxInvoice + Receipt รวมใบเดียว, ตัดหนี้ทันที)
  → docDate = payDate

ELSE (payDate >= dueDate):
  → /invoices/queue (TaxInvoice เท่านั้น, ยังไม่ตัดหนี้)
  → docDate = dueDate
  → เปิด Receipt แยกเมื่อรับชำระจริง, docDate = payDate
```
เลขที่ TaxInvoice และ Receipt รันอิสระจากกันเสมอ

**Why:** SME Move รวมใบ → ยอดลูกหนี้ผิดเมื่อจ่ายหลังกำหนด — เหตุผลหลักที่เปลี่ยนมา PEAK

### Idempotency
- ตรวจคอลัมน์ผลลัพธ์ว่าว่างก่อน call API ทุกครั้ง
- บันทึก "PROCESSING" ก่อน call → update เลขจริงหลัง poll
- ป้องกัน duplicate เมื่อ GAS timeout (6 นาที)

### ค่าปรับ (Part 3)
- ไม่มี VAT เสมอ
- เปิดเป็น Receipt อย่างเดียว
- ลูกค้าอาจจ่ายค่าปรับงวดเก่าพร้อมงวดปัจจุบัน

### PEAK API Key Notes
- POST ทุก endpoint return HTTP 200 แม้ error → ต้องเช็ค `data.isSuccess === false`
- Client-Token อายุ 24 ชม. cache ใน ScriptProperties
- Auth: HMAC-SHA1(Time-Stamp, connectId) → Time-Signature header

### ระบบ Part 1 ไม่พึ่ง PEAK installment notification
- ดึงข้อมูลจาก Receipt Sheet (actual payments) โดยตรง
- ไม่ต้องรอ PEAK แจ้งว่า "ถึงงวด" — Sheet รับชำระเป็น source of truth
- เจ้าหน้าที่ PEAK พูดถึง PEAK's own feature ที่ไม่มี — ไม่เกี่ยวกับระบบเรา

---

## Pending Tasks (เรียงลำดับสำคัญ)

1. **⏳ รอ PEAK credentials** → ทดสอบ Parts 1-4
2. **clasp push** — deploy โค้ดล่าสุด (00_Config.gs + 11_WebApp.gs + 09_Dashboard.gs) ขึ้น GAS
3. **Rebuild installer** — รัน PyInstaller → ISCC หลังแก้ main.py
4. **Investigate Part 3 "168 ทำแล้ว"** — มีรายการที่แสดง 168 "ทำแล้ว" ผิดปกติ ต้องตรวจก่อน production
5. **Rewrite column mapping** — เมื่อพี่นกยืนยัน Tab Statement + format final

---

## PEAK API Endpoints สำคัญ
```
POST /Receipts/allinone → { peakReceipts: { ...single... } }
POST /Receipts/queue    → { peakReceipts: [...array...] }
POST /Invoices/allinone → { peakInvoices: { ...single... } }
POST /Invoices/queue    → { peakInvoices: [...array...] }
POST /CreditNotes       → { peakCreditNotes: { ... } }
```
Base: `https://api.peakaccount.com/api/v1/`
Headers: `Client-Token`, `User-Token`, `Time-Stamp`, `Time-Signature`
