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

  const guard = makeTimeGuard_(5);
  let stoppedEarly = false, quotaHit = false;

  for (let i = 0; i < data.length; i++) {
    if (guard.expired()) { stoppedEarly = true; break; }
    const row = data[i];

    // ─── Guard ────────────────────────────────────────────────────────────
    const invCode = String(row[CONFIG.RETURN_COL.INV] || '').trim();
    if (!invCode) continue;

    // ─── Workflow filter: ออกใบลดหนี้เฉพาะ workflow ที่ระบุใน Config ──────
    const workflow = String(row[CONFIG.RETURN_COL.WORKFLOW] || '').trim();
    if (CONFIG.RETURN_WORKFLOW_ISSUE_CN && CONFIG.RETURN_WORKFLOW_ISSUE_CN.length > 0) {
      if (!CONFIG.RETURN_WORKFLOW_ISSUE_CN.includes(workflow)) {
        logEntry('Part4', CONFIG.RETURN_SHEET_NAME, i, invCode, 'SKIP', '', `workflow "${workflow}" ไม่อยู่ใน RETURN_WORKFLOW_ISSUE_CN — ข้าม`);
        countSkip++;
        continue;
      }
    }

    // ─── Idempotency ──────────────────────────────────────────────────────
    const existingCN = String(row[CONFIG.RETURN_COL.CN_DOC] || '').trim();
    if (existingCN && existingCN !== CONFIG.PROCESSING_MARKER) {
      countSkip++;
      continue;
    }

    // ─── Parse วันที่รับคืน (DD/MM/YYYY) ────────────────────────────────
    const returnDateRaw = row[CONFIG.RETURN_COL.RETURN_DATE];
    const returnDate = returnDateRaw instanceof Date
      ? returnDateRaw
      : parseMDYDate_(String(returnDateRaw || '').trim());

    if (!returnDate) {
      Logger.log(`Part4 ERROR [${invCode}]: parse วันที่รับคืนไม่ได้: "${returnDateRaw}"`);
      logEntry('Part4', CONFIG.RETURN_SHEET_NAME, i, invCode, 'ERROR', '', `parse วันที่รับคืนไม่ได้: "${returnDateRaw}"`);
      countError++;
      continue;
    }

    // ─── คำนวณยอดใบลดหนี้ ────────────────────────────────────────────────
    const contractAmt = parseAmount(row[CONFIG.RETURN_COL.CONTRACT_AMT]);
    const paidAmt = parseAmount(row[CONFIG.RETURN_COL.PAID_AMT]);
    const creditAmt = contractAmt - paidAmt;

    if (creditAmt <= 0) {
      logEntry('Part4', CONFIG.RETURN_SHEET_NAME, i, invCode, 'SKIP', '',
        `ยอดใบลดหนี้ = ${creditAmt} (ปิดยอดแล้วหรือไม่ต้องออก)`);
      countSkip++;
      continue;
    }

    // ─── Build metadata ───────────────────────────────────────────────────
    const productModel = String(row[CONFIG.RETURN_COL.MODEL] || '').trim();
    const imei = String(row[CONFIG.RETURN_COL.IMEI] || '').trim();
    const prefix = String(row[CONFIG.RETURN_COL.TITLE] || '').trim();
    const nameOnly = String(row[CONFIG.RETURN_COL.NAME] || '').trim();
    const customerName = (prefix && !nameOnly.startsWith(prefix))
      ? `${prefix}${nameOnly}`.trim()
      : nameOnly;
    const branch = String(row[CONFIG.RETURN_COL.BRANCH] || '').trim();

    // ─── Mark PROCESSING ──────────────────────────────────────────────────
    writeCell(sheet, i, CONFIG.RETURN_COL.CN_DOC, CONFIG.PROCESSING_MARKER);

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

      writeCell(sheet, i, CONFIG.RETURN_COL.CN_DOC, docNo);
      logEntry('Part4', CONFIG.RETURN_SHEET_NAME, i, invCode, 'SUCCESS', docNo);
      countOk++;

    } catch (e) {
      const kind = classifyError_(e);
      if (kind === 'quota') {
        writeCell(sheet, i, CONFIG.RETURN_COL.CN_DOC, '');
        logEntry('Part4', CONFIG.RETURN_SHEET_NAME, i, invCode, 'WARN', '', `หยุดชั่วคราว (quota): ${e.message}`);
        quotaHit = true;
        stoppedEarly = true;
        break;
      }
      if (kind === 'duplicate') {
        const cnRef = buildReference(invCode, formatDateForAPI(returnDate), 'CN');
        const recovered = tryRecoverPeakDoc_('/creditnotes', cnRef);
        if (recovered) {
          writeCell(sheet, i, CONFIG.RETURN_COL.CN_DOC, recovered);
          logEntry('Part4', CONFIG.RETURN_SHEET_NAME, i, invCode, 'SUCCESS', recovered, 'กู้เลขเอกสารซ้ำ');
          countOk++;
        } else {
          writeCell(sheet, i, CONFIG.RETURN_COL.CN_DOC, CONFIG.DUPLICATE_MARKER);
          logEntry('Part4', CONFIG.RETURN_SHEET_NAME, i, invCode, 'WARN', CONFIG.DUPLICATE_MARKER,
            'ใบลดหนี้มีใน PEAK แล้ว — ค้นหาเลขที่ใน PEAK แล้วอัปเดตเซลล์ด้วยตนเอง');
        }
        continue;
      }
      writeCell(sheet, i, CONFIG.RETURN_COL.CN_DOC, '');
      Logger.log(`Part4 ERROR [${invCode}]: ${e.message}\nStack: ${e.stack || '(no stack)'}`);
      logEntry('Part4', CONFIG.RETURN_SHEET_NAME, i, invCode, 'ERROR', '', e.message);
      countError++;
    }
  }

  let tail = '';
  if (stoppedEarly) {
    scheduleContinuation_('runPart4_CreditNote', '', countOk > 0);
    tail = quotaHit
      ? ' ⏸️ หยุดชั่วคราว (โควตา) — ทำต่ออัตโนมัติใน 15 นาที'
      : ' ⏸️ หยุดกันหมดเวลา — ทำต่ออัตโนมัติใน 15 นาที';
  } else {
    clearContinuation_('runPart4_CreditNote');
  }
  const summary = `Part 4 เสร็จ — สร้างแล้ว: ${countOk}, ข้าม: ${countSkip}, Error: ${countError}${tail}`;
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
    contact:     { id: contactUuid, code: String(invCode), name: customerName },
    taxStatus:   1,
    // subType ตามมาตรา 86/10: 1=สินค้าส่งคืน, 2=คำนวณราคาผิด, 3=ใบกำกับออกผิด, 4=ลดราคา, 5=อื่น ๆ
    // MTECH = คืนเครื่อง → 1
    subType:     1,
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
 * แปลง "DD/MM/YYYY" (Thai format) → Date object
 * ถ้าตัวเลขแรก > 12 → ชัดเจนว่าเป็น DD; ถ้าไม่ชัดเจนก็ถือ DD/MM/YYYY เป็น default
 */
function parseMDYDate_(s) {
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const [, dd, mm, yyyy] = m;  // DD/MM/YYYY (Thai date format)
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
