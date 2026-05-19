/**
 * FinFin Automation System — Configuration
 *
 * อิงโครงสร้าง Google Sheet จริงของพี่นก (2026-04-20)
 *   - Sum.MM.YYYY      (Contract list, no payment inline)
 *   - Receipt.MM.YYYY  (Payment records — source of truth)
 *   - SCB.MM.YYYY      (Bank Statement w/ INV note)
 *   - ไฟล์รับคืน       (Device returns → Credit Note)
 */

// ─── PEAK Credentials (กรอกหลังได้รับจาก PEAK) ───────────────────────────
const CONFIG = {
  CONNECT_ID: 'mptechcorporation_peakapi_uat',  // ConnectId จาก PEAK ZIP
  CONNECT_PASSWORD: 'sJY3C7rB3QrrBpG4nXcR',    // ConnectKey จาก PEAK ZIP
  USER_TOKEN: 'ccd8bef1-ce62-4432-9380-426bee768c34',  // MPTechCorporation UAT (15/05/2026)
  BASE_URL: 'http://peakengineapidev.azurewebsites.net/api/v1',  // UAT

  // ─── Account Codes (ยืนยันกับ FinFin ก่อน deploy) ────────────────────────
  ACCOUNT_CODE_SALES: '410101',      // ขาย (ยืนยันใน PEAK UAT แล้ว — 410000 ไม่มีในระบบ)
  ACCOUNT_CODE_LATE_FEE: '420000',
  ACCOUNT_CODE_SERVICE_FEE: '410101',
  ACCOUNT_CODE_AR: '110000',

  // ─── VAT / Payment Types ─────────────────────────────────────────────────
  // PEAK: vatType 1=ไม่มี VAT, 2=VAT 0%, 3=VAT 7%
  VAT_TYPE_7: 3,
  VAT_TYPE_NONE: 1,
  PMT_TRANSFER: 8,
  PMT_CASH: 1,

  // ─── Google Sheet Settings ───────────────────────────────────────────────
  SPREADSHEET_ID: '123EwnVGDbuaBg0HTsZhpdX8EgKvfa7nja9ngfenN5Zo',

  // Sheet สัญญาใหม่ (Part 2)
  CONTRACT_SHEET_NAME: 'สัญญาใหม่',

  // Sheet naming prefixes — ต่อท้ายด้วย "MM.YYYY" อัตโนมัติ → "Sum05.2026"
  SUM_SHEET_PREFIX: 'Sum',
  RECEIPT_SHEET_PREFIX: 'Receipt',
  STATEMENT_SHEET_PREFIX: 'SCB',

  // Sheet ไฟล์รับคืนเครื่อง (อยู่คนละ Spreadsheet ได้)
  RETURN_SPREADSHEET_ID: 'SPREADSHEET_ID_OF_RETURN_FILE',
  RETURN_SHEET_NAME: 'ไฟล์รับคืน',

  // ─── Sum Sheet Columns (รายละเอียดสัญญา — Mar 2026 layout) ───────────────
  // Header แถว 2, data เริ่มแถว 3
  SUM_HEADER_ROW: 2,
  COL: {
    SEQ:              0,   // ลำดับ
    CONTRACT_DATE:    1,   // วันที่ทำสัญญา
    INV:              2,   // เลขที่สัญญา ← KEY (join กับ Receipt, SCB)
    TITLE:            3,   // คำนำหน้าชื่อ
    NAME:             4,   // ชื่อลูกค้า
    CONTRACT_AMT:     5,   // ยอดทำสัญญา
    INSTALLMENT_N:    6,   // จำนวนงวด
    INSTALLMENT_AMT:  7,   // ผ่อนงวดละ
    PAY_DAY:          8,   // จ่ายทุกวันที่
    BRANCH:           9,   // สาขา
    AR_BEGIN:         10,  // ลูกหนี้คงเหลือต้นงวด
    DOWN_OR_MONTHLY:  11,  // เงินดาวน์ / ค่างวด
    LATE_FEE:         12,  // ค่าปรับ
    SERVICE_FEE:      13,  // ค่าบริการเพิ่มเติม
    CLOSEOUT_DISC:    14,  // ส่วนลดปิดยอด
    AR_END:           15,  // ลูกหนี้คงเหลือปลายงวด
    DUE_DATE:         16,  // วันที่ครบกำหนดค่างวด (MM.YY)
  },

  // ─── Receipt Sheet Columns (รายการรับชำระ — source of truth) ─────────────
  // Header แถว 2 (row 1 = summary totals, row 3 เริ่ม data)
  RECEIPT_HEADER_ROW: 2,
  RECEIPT_COL: {
    INV:          0,  // เลขที่สัญญา ← KEY
    DUE_DATE:     1,  // วันที่ครบกำหนด
    INST_TYPE:    2,  // ประเภทการชำระ (ง.8 / ดาวน์ / ปิดยอด)
    PAY_DATE:     3,  // วันที่รับชำระ (จากธนาคารจริง)
    TAX_DATE:     4,  // วันที่เปิดใบกำกับภาษี (Pi Nok ใส่ตาม Date Logic)
    SMEMOVE_DOC:  5,  // ใบเสร็จรับเงินเดิมจาก smemove (IVF-YYMMDD-NNN = ใบกำกับภาษี / IFF-YYMMDD-NNN = ค่าปรับ)
    NAME:         6,  // ชื่อลูกค้า
    AMT:          7,  // ยอดเงินรวม
    PEAK_DOC:     8,  // ← OUTPUT: เลขที่ใบกำกับ PEAK (auto-create column)
  },

  // ─── SCB Bank Statement — รองรับ 2 format (auto-detect ใน Part 5) ────────
  // Format A: RAW bank CSV export (16 cols, header แถว 1)
  STATEMENT_FORMAT_RAW: {
    HEADER_ROW: 1,
    COL: {
      DATE:       5,   // วัน/Date DD/MM/YYYY
      TIME:       6,
      WITHDRAWAL: 11,
      DEPOSIT:    12,  // ยอดเงินเข้า
      DESC:       14,  // Description (bank auto)
      NOTE:       15,  // Note (ชะเอมกรอก INV)
    },
  },
  // Format B: ENHANCED SCB sheet (พี่นกเพิ่ม column งวด/ค่าปรับ, header แถว 6)
  STATEMENT_FORMAT_ENHANCED: {
    HEADER_ROW: 6,
    COL: {
      DATE:       0,
      TIME:       1,
      DEPOSIT:    2,
      DESC:       3,
      NOTE:       4,
      INV:        5,
      INST_TYPE:  7,
      LATE_FEE:   10,
      PAY_DATE:   11,
    },
  },
  STATEMENT_REPORT_NAME: 'STATEMENT_REPORT',

  // ─── ไฟล์รับคืน Columns (0-based) ─────────────────────────────────────────
  RETURN_COL: {
    SEQ:          0,   // จำนวน (ลำดับ)
    RETURN_DATE:  1,   // วันที่รับคืน
    CONTRACT_DT:  2,   // วันที่ทำสัญญา
    INV:          3,   // เลขที่สัญญา
    TITLE:        4,
    NAME:         5,
    IMEI:         6,
    MODEL:        7,
    CONDITION:    8,
    BRANCH:       9,
    CONTRACT_AMT: 10,
    DOWN:         11,
    MONTHLY:      12,
    PAID_COUNT:   13,  // จำนวนงวดที่ชำระแล้ว
    PAID_AMT:     14,  // รวมเงินที่จ่ายมาแล้ว
    WORKFLOW:     15,  // สถานะงาน (ขายส่ง Yellobe / ผ่อนต่อ finfin)
    CN_DOC:       16,  // ← OUTPUT: เลขที่ใบลดหนี้
  },

  // Workflow values ที่ต้องออกใบลดหนี้
  // (confirm กับพี่นก: "ผ่อนต่อ finfin" อาจไม่ต้องออก CN เพราะโอนสัญญา)
  RETURN_WORKFLOW_ISSUE_CN: ['ขายส่ง Yellobe'],

  // ─── Log Sheet ────────────────────────────────────────────────────────────
  LOG_SHEET_NAME: 'PEAK_LOG',

  // ─── Batch & Status ──────────────────────────────────────────────────────
  BATCH_SIZE: 50,
  STATUS_PAID: ['จ่ายแล้ว', 'ปิดยอด'],
  PROCESSING_MARKER: 'PROCESSING',
  DUPLICATE_MARKER:  '[IN-PEAK]',   // เอกสารมีใน PEAK แล้วแต่ไม่รู้เลขที่ — ให้ user ค้นหาเอง

  // ─── Dashboard ────────────────────────────────────────────────────────────
  DASHBOARD_SHEET_NAME: 'DASHBOARD',

  // ─── Backward-compat / legacy keys ───────────────────────────────────────
  STATEMENT_SHEET_NAME: 'SCB',
  SVC_FEE_COL: {
    AMT:  13,
    DATE: -1, TYPE: -1, DOC: -1,
  },
};

// ─── Legacy letter-based aliases (Feb 2026 layout) ──────────────────────────
// ⚠️ ใช้ใน Part 3 / 07_PollResults (ยังไม่ได้ migrate). เมื่อ Sum sheet เปลี่ยน
// เป็น Mar layout ตัวอักษรเหล่านี้อาจชี้ไปที่ column ที่ไม่มีอยู่ → row[idx] = undefined
// → logic เดิมจะ skip row อัตโนมัติ
Object.assign(CONFIG.COL, {
  A:0, B:1, C:2, D:3, E:4, F:5, G:6, H:7, I:8, J:9,
  K:10, L:11, M:12, N:13, O:14, P:15, Q:16, R:17, S:18, T:19,
  U:20, V:21, W:22, X:23, Y:24, Z:25,
});
Object.assign(CONFIG.RETURN_COL, {
  A:0, B:1, C:2, D:3, E:4, F:5, G:6, H:7, I:8, J:9,
  K:10, L:11, M:12, N:13, O:14, P:15, Q:16,
});

function testSumSheet() {
  const ss = SpreadsheetApp.openById("123EwnVGDbuaBg0HTsZhpdX8EgKvfa7nja9ngfenN5Zo");
  const sheet = ss.getSheetByName("Sum03.2026");
  const data = sheet.getDataRange().getValues();
  Logger.log("จำนวนแถว: " + data.length);
  Logger.log("ตัวอย่างแถวแรก (ข้อมูลจริง): " + data[2]); // แถวที่ 3 เพราะมี header 2 แถว
}
