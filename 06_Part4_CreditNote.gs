/**
 * FinFin Automation — Part 4: ออกใบลดหนี้ (คืนเครื่อง)
 *
 * Business Rules:
 *   - วัตถุประสงค์: เคลียร์ใบแจ้งหนี้ที่ค้างอยู่ใน PEAK เมื่อลูกค้าคืนเครื่อง
 *   - ไม่ใช่การคืนเงินให้ลูกค้า
 *   - วันที่ใบลดหนี้ = วันที่รับคืน (Col B ไฟล์รับคืน)
 *   - อ้างอิง INV จาก Col D (เลขที่สัญญา)
 *   - ยอดใบลดหนี้ = ยอดทำสัญญา - รวมเงินที่จ่ายมาแล้ว
 *     (= งวดที่ค้างอยู่ที่ต้องเคลียร์)
 *
 * Input: ไฟล์รับคืน (RETURN_SPREADSHEET_ID / RETURN_SHEET_NAME)
 *   - Date format: MM/DD/YYYY
 *   - ยอดเงินมี comma
 *   - ยังไม่มี col เลขที่ใบลดหนี้ → เพิ่ม Col Q อัตโนมัติ
 *
 * Output:
 *   - เขียนเลขที่ใบลดหนี้ → Col Q (index 16)
 */

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * รันออกใบลดหนี้จากไฟล์รับคืน
 */
function runPart4_CreditNote() {
  preFlightChecks_();
  let ss, sheet;

  // ─── เปิดไฟล์รับคืน ───────────────────────────────────────────────────────
  try {
    const returnId = CONFIG.RETURN_SPREADSHEET_ID;
    if (!returnId || returnId === 'SPREADSHEET_ID_OF_RETURN_FILE') {
      // ไม่ได้ระบุ ID แยก → ถือว่าอยู่ใน Spreadsheet เดียวกัน
      ss = SpreadsheetApp.openById(getSpreadsheetId());
    } else {
      ss = SpreadsheetApp.openById(returnId);
    }
    sheet = ss.getSheetByName(CONFIG.RETURN_SHEET_NAME);
    if (!sheet) throw new Error(`ไม่พบ Sheet "${CONFIG.RETURN_SHEET_NAME}"`);
  } catch (e) {
    throw new Error(`เปิดไฟล์รับคืนไม่ได้: ${e.message}`);
  }

  toast(`⏳ กำลังประมวลผล Part 4 ใบลดหนี้`, 'FinFin');

  // ─── เพิ่ม Header Col Q ถ้ายังไม่มี ──────────────────────────────────────
  ensureReturnFileHeader_(sheet);

  const data = getSheetData(sheet);
  let countOk = 0, countSkip = 0, countError = 0;

  for (let i = 0; i < data.length; i++) {
    const row = data[i];

    // ─── Guard ────────────────────────────────────────────────────────────
    const invCode = String(row[CONFIG.RETURN_COL.D] || '').trim();
    if (!invCode) continue;

    // ─── Idempotency ──────────────────────────────────────────────────────
    const existingCN = String(row[CONFIG.RETURN_COL.Q] || '').trim();
    if (existingCN && existingCN !== CONFIG.PROCESSING_MARKER) {
      countSkip++;
      continue;
    }

    // ─── Parse วันที่รับคืน (MM/DD/YYYY) ────────────────────────────────
    const returnDateRaw = row[CONFIG.RETURN_COL.B];
    const returnDate = returnDateRaw instanceof Date
      ? returnDateRaw
      : parseMDYDate_(String(returnDateRaw || '').trim());

    if (!returnDate) {
      logEntry('Part4', CONFIG.RETURN_SHEET_NAME, i, invCode, 'ERROR', '', `parse วันที่รับคืนไม่ได้: "${returnDateRaw}"`);
      countError++;
      continue;
    }

    // ─── คำนวณยอดใบลดหนี้ ────────────────────────────────────────────────
    const contractAmt = parseAmount(row[CONFIG.RETURN_COL.K]);
    const paidAmt = parseAmount(row[CONFIG.RETURN_COL.O]);
    const creditAmt = contractAmt - paidAmt;

    if (creditAmt <= 0) {
      logEntry('Part4', CONFIG.RETURN_SHEET_NAME, i, invCode, 'SKIP', '',
        `ยอดใบลดหนี้ = ${creditAmt} (ปิดยอดแล้วหรือไม่ต้องออก)`);
      countSkip++;
      continue;
    }

    // ─── Build metadata ───────────────────────────────────────────────────
    const productModel = String(row[CONFIG.RETURN_COL.H] || '').trim();
    const imei = String(row[CONFIG.RETURN_COL.G] || '').trim();
    const customerName = String(row[CONFIG.RETURN_COL.F] || '').trim();
    const branch = String(row[CONFIG.RETURN_COL.J] || '').trim();

    // ─── Mark PROCESSING ──────────────────────────────────────────────────
    writeCell(sheet, i, CONFIG.RETURN_COL.Q, CONFIG.PROCESSING_MARKER);

    try {
      // ensure contact exists + resolve UUID (Part 1 format: contact:{id,code})
      ensureContactsBatch_({ [invCode]: customerName });
      const contactUuid = getContactId_(invCode);
      if (!contactUuid) throw new Error('ไม่พบ contactId — รัน Sync Contacts ก่อน');

      const payload = buildCreditNotePayload(
        invCode, contactUuid, returnDate, creditAmt, productModel, imei, customerName, branch
      );
      const res = callPeakAPI('post', '/creditnotes', { PeakCreditNotes: { creditNotes: [payload] } });
      const cn = (res.PeakCreditNotes && res.PeakCreditNotes.creditNotes && res.PeakCreditNotes.creditNotes[0]) || res;
      const docNo = cn.creditNoteCode || cn.code || JSON.stringify(res).substring(0, 80);

      writeCell(sheet, i, CONFIG.RETURN_COL.Q, docNo);
      logEntry('Part4', CONFIG.RETURN_SHEET_NAME, i, invCode, 'SUCCESS', docNo);
      countOk++;

    } catch (e) {
      writeCell(sheet, i, CONFIG.RETURN_COL.Q, '');  // ลบ PROCESSING
      logEntry('Part4', CONFIG.RETURN_SHEET_NAME, i, invCode, 'ERROR', '', e.message);
      countError++;
    }
  }

  const summary = `Part 4 เสร็จ — สร้างแล้ว: ${countOk}, ข้าม: ${countSkip}, Error: ${countError}`;
  toast(summary, 'FinFin', 10);
  Logger.log(summary);
  return summary;
}

// ─── Payload Builder ──────────────────────────────────────────────────────────

/**
 * สร้าง payload ใบลดหนี้
 */
function buildCreditNotePayload(invCode, contactUuid, returnDate, creditAmt, product, imei, customerName, branch) {
  const desc = `คืนเครื่อง ${product}${imei ? ` IMEI ${imei}` : ''} สาขา ${branch} — ${customerName}`;

  return {
    code:        buildReference(invCode, formatDateForAPI(returnDate), 'CN'),
    issuedDate:  formatDateForAPI(returnDate),
    contact:     { id: contactUuid, code: String(invCode) },
    taxStatus:   1,
    remark:      desc,
    products: [
      {
        accountCode: CONFIG.ACCOUNT_CODE_SALES,
        description: desc,
        quantity: 1,
        price: creditAmt,
        vatType: CONFIG.VAT_TYPE_7,
      },
    ],
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * แปลง "MM/DD/YYYY" หรือ "M/D/YYYY" → Date object
 * (ไฟล์รับคืนใช้ format นี้)
 */
function parseMDYDate_(s) {
  if (!s) return null;
  // MM/DD/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) {
    // ลอง parse ทั่วไป
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const [, mm, dd, yyyy] = m;
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), 12, 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * เพิ่ม header "เลขที่ใบลดหนี้" ใน Col Q ถ้ายังไม่มี
 */
function ensureReturnFileHeader_(sheet) {
  const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const lastColIdx = headerRow.length; // 0-based last index

  // ตรวจว่า Col Q (index 16) มีค่าหรือยัง
  if (lastColIdx <= 16 || !headerRow[16]) {
    sheet.getRange(1, 17).setValue('เลขที่ใบลดหนี้');  // Col Q = column 17 (1-indexed)
  }
}
