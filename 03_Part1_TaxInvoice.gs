/**
 * FinFin Automation — Part 1: ออกใบกำกับภาษี + ใบเสร็จ bulk
 *
 * Source: Receipt sheet (Receipt.MM.YYYY) — payment records
 *   col: INV / DUE_DATE / INST_TYPE / PAY_DATE / TAX_DATE / SMEMOVE_DOC /
 *        NAME / AMT / PEAK_DOC (output)
 *
 * Date Logic:
 *   Case A — payDate < dueDate (จ่ายก่อนกำหนด):
 *     → POST /Receipts/allinone  (Tax+Receipt รวมใบเดียว, date = payDate)
 *
 *   Case B — payDate >= dueDate (จ่ายตรง/หลังกำหนด):
 *     → POST /Invoices/queue    (TaxInvoice, date = dueDate)
 *     → POST /Receipts/queue    (Receipt, date = payDate)
 *
 * Filter: invCode มี, amt > 0, payDate มี, PEAK_DOC ว่าง (idempotency)
 */

// ─── Main Entry Point ─────────────────────────────────────────────────────────

function runPart1_TaxInvoice(sheetName) {
  sheetName = sheetName || getCurrentReceiptSheetName();
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error(`ไม่พบ Sheet "${sheetName}"`);

  ensureReceiptHeader_(sheet);
  const data = getReceiptData_(sheet);

  toast(`⏳ Part 1 — ${sheetName}`, 'FinFin');

  const batchA = [];     // Case A allinone
  const batchB_tax = []; // Case B tax invoice
  const batchB_rec = []; // Case B receipt
  let countSkip = 0, countError = 0;
  const nameMap = {};    // invCode → customer name (for contact sync)

  for (let i = 0; i < data.length; i++) {
    const row = data[i];

    const invCode = String(row[CONFIG.RECEIPT_COL.INV] || '').trim();
    if (!invCode) continue;
    nameMap[invCode] = nameMap[invCode] || String(row[CONFIG.RECEIPT_COL.NAME] || '').trim();

    const amt = parseAmount(row[CONFIG.RECEIPT_COL.AMT]);
    if (amt <= 0) { countSkip++; continue; }

    const existingDoc = String(row[CONFIG.RECEIPT_COL.PEAK_DOC] || '').trim();
    if (existingDoc && existingDoc !== CONFIG.PROCESSING_MARKER) { countSkip++; continue; }

    // smemove IFF- = ใบเสร็จค่าปรับ → Part 1 ไม่ออก ให้ Part 3 จัดการ
    const smemoveDoc = String(row[CONFIG.RECEIPT_COL.SMEMOVE_DOC] || '').trim();
    if (smemoveDoc.startsWith('IFF-')) { countSkip++; continue; }

    const payDate = toDate(row[CONFIG.RECEIPT_COL.PAY_DATE]);
    if (!payDate) {
      logEntry('Part1', sheetName, i, invCode, 'SKIP', '', 'ไม่มี PAY_DATE');
      countSkip++;
      continue;
    }

    const dueDate = toDate(row[CONFIG.RECEIPT_COL.DUE_DATE]);
    const installment = String(row[CONFIG.RECEIPT_COL.INST_TYPE] || '').trim();
    const desc = buildReceiptDescription_(installment, invCode);
    const payType = CONFIG.PMT_TRANSFER;  // default — Receipt sheet ไม่มีช่องระบุวิธีการชำระ

    // ─── Mark PROCESSING ──────────────────────────────────────────────────
    writeReceiptCell_(sheet, i, CONFIG.RECEIPT_COL.PEAK_DOC, CONFIG.PROCESSING_MARKER);

    // ใช้เลขที่ smemove (IVF-YYMMDD-NNN) เป็น code ใน PEAK เพื่อ reconcile ได้ตรง
    // ถ้าไม่มี → ใช้ buildReference ตามปกติ
    const smemoveTaxRef = smemoveDoc.startsWith('IVF-') ? smemoveDoc : null;

    if (dueDate && compareDates(payDate, dueDate) < 0) {
      const ref = smemoveTaxRef || buildReference(invCode, installment || 'X', 'TAX');
      batchA.push({
        rowIndex: i, invCode, ref,
        payload: buildAllinonePayload(invCode, payDate, amt, desc, payType, ref),
      });
    } else {
      const taxDate = dueDate || payDate;
      const refTax = smemoveTaxRef || buildReference(invCode, installment || 'X', 'TAX');
      const refRec = buildReference(invCode, installment || 'X', 'REC');
      batchB_tax.push({
        rowIndex: i, invCode, ref: refTax,
        payload: buildTaxInvoiceOnlyPayload(invCode, taxDate, amt, desc, refTax),
      });
      batchB_rec.push({
        rowIndex: i, invCode, ref: refRec,
        payload: buildReceiptOnlyPayload(invCode, payDate, amt, desc, payType, refRec),
      });
    }
  }

  // ─── Sync contacts to PEAK before submission ─────────────────────────────
  {
    const batchCodes = {};
    [...batchA, ...batchB_tax].forEach(x => {
      if (!batchCodes[x.invCode]) batchCodes[x.invCode] = nameMap[x.invCode] || '';
    });
    const n = Object.keys(batchCodes).length;
    if (n > 0) {
      toast(`⏳ Sync ${n} contacts...`, 'FinFin');
      ensureContactsBatch_(batchCodes);
    }
  }

  // ─── Resolve contactId (UUID) for endpoints that require it ──────────────
  // /receipts/allinone และ /invoices/queue ต้องการ contactId (UUID) ไม่ใช่ contactCode
  // /receipts/queue ใช้ contactCode ปกติ — batchB_rec ไม่ต้องแก้
  for (const item of [...batchA, ...batchB_tax]) {
    const cid = getContactId_(item.invCode);
    if (cid) {
      item.payload.contactId = cid;
      delete item.payload.contactCode;
    } else {
      Logger.log(`Part1: ไม่พบ contactId สำหรับ ${item.invCode} — อาจเกิด Missing Contact Data`);
    }
  }

  let countA = 0, countB = 0;

  // ─── Submit Case A (one by one) ───────────────────────────────────────────
  for (const item of batchA) {
    try {
      const res = callPeakAPI('post', '/receipts/allinone', { PeakReceipts: { receipts: [item.payload] } });
      const rec = (res.PeakReceipts && res.PeakReceipts.receipts && res.PeakReceipts.receipts[0]) || res;
      const docNo = [rec.taxInvoiceCode || rec.code, rec.receiptCode].filter(Boolean).join(' / ') || JSON.stringify(res).slice(0, 80);
      writeReceiptCell_(sheet, item.rowIndex, CONFIG.RECEIPT_COL.PEAK_DOC, docNo);
      logEntry('Part1', sheetName, item.rowIndex, item.invCode, 'SUCCESS', docNo, 'Case A');
      countA++;
    } catch (e) {
      writeReceiptCell_(sheet, item.rowIndex, CONFIG.RECEIPT_COL.PEAK_DOC, '');
      logEntry('Part1', sheetName, item.rowIndex, item.invCode, 'ERROR', '', e.message);
      countError++;
    }
  }

  // ─── Submit Case B (queue) ────────────────────────────────────────────────
  if (batchB_tax.length > 0) {
    for (const chunk of chunkArray(batchB_tax, CONFIG.BATCH_SIZE)) {
      try {
        const res = callPeakAPI('post', '/invoices/queue',
          { PeakInvoices: { invoices: chunk.map(x => x.payload) } });
        const queueId = res.queueId || res.id || 'unknown';
        saveQueueEntry('invoice', queueId, sheetName,
          chunk.map(x => ({
            rowIndex: x.rowIndex, invCode: x.invCode, docType: 'TAX',
            targetSheet: sheetName,
            targetCol: CONFIG.RECEIPT_COL.PEAK_DOC,
            headerOffset: CONFIG.RECEIPT_HEADER_ROW,
          })));
        logEntry('Part1', sheetName, -1, 'BATCH', 'QUEUED', queueId, `Case B Tax ${chunk.length}`);
        countB += chunk.length;
      } catch (e) {
        chunk.forEach(x => writeReceiptCell_(sheet, x.rowIndex, CONFIG.RECEIPT_COL.PEAK_DOC, ''));
        logEntry('Part1', sheetName, -1, 'BATCH', 'ERROR', '', `Case B Tax: ${e.message}`);
        countError += chunk.length;
      }
    }
  }
  if (batchB_rec.length > 0) {
    for (const chunk of chunkArray(batchB_rec, CONFIG.BATCH_SIZE)) {
      try {
        const res = callPeakAPI('post', '/receipts/queue',
          { PeakReceipts: { receipts: chunk.map(x => x.payload) } });
        const queueId = res.queueId || res.id || 'unknown';
        saveQueueEntry('receipt', queueId, sheetName,
          chunk.map(x => ({
            rowIndex: x.rowIndex, invCode: x.invCode, docType: 'REC',
            targetSheet: sheetName,
            targetCol: CONFIG.RECEIPT_COL.PEAK_DOC,
            headerOffset: CONFIG.RECEIPT_HEADER_ROW,
          })));
        logEntry('Part1', sheetName, -1, 'BATCH', 'QUEUED', queueId, `Case B Rec ${chunk.length}`);
      } catch (e) {
        logEntry('Part1', sheetName, -1, 'BATCH', 'ERROR', '', `Case B Rec: ${e.message}`);
        countError += chunk.length;
      }
    }
  }

  const summary = `Part 1 เสร็จ — Case A: ${countA}, Queue B: ${countB}, Skip: ${countSkip}, Error: ${countError}`;
  toast(summary, 'FinFin', 10);
  Logger.log(summary);
  return summary;
}

// ─── Payload Builders ─────────────────────────────────────────────────────────

function buildAllinonePayload(invCode, payDate, amount, desc, payType, ref) {
  return {
    code:         ref,
    issuedDate:   formatDateForAPI(payDate),
    dueDate:      formatDateForAPI(payDate),
    contactCode:  String(invCode),
    isTaxInvoice: 1,
    remark:       desc,
    products: [{
      accountCode: CONFIG.ACCOUNT_CODE_SALES,
      description: desc,
      quantity:    1,
      price:       amount,
      vatType:     CONFIG.VAT_TYPE_7,
    }],
    paidPayments: {
      paymentDate: formatDateForAPI(payDate),
      payments: [{ amount: amount }],
    },
  };
}

function buildTaxInvoiceOnlyPayload(invCode, taxDate, amount, desc, ref) {
  return {
    code:         ref,
    issuedDate:   formatDateForAPI(taxDate),
    dueDate:      formatDateForAPI(taxDate),
    contactCode:  String(invCode),
    isTaxInvoice: 1,
    remark:       desc,
    products: [{
      accountCode: CONFIG.ACCOUNT_CODE_SALES,
      description: desc,
      quantity:    1,
      price:       amount,
      vatType:     CONFIG.VAT_TYPE_7,
    }],
  };
}

function buildReceiptOnlyPayload(invCode, payDate, amount, desc, payType, ref) {
  return {
    code:         ref,
    issuedDate:   formatDateForAPI(payDate),
    dueDate:      formatDateForAPI(payDate),
    contactCode:  String(invCode),
    isTaxInvoice: 0,
    remark:       desc,
    products: [{
      accountCode: CONFIG.ACCOUNT_CODE_SALES,
      description: desc,
      quantity:    1,
      price:       amount,
      vatType:     CONFIG.VAT_TYPE_7,
    }],
    paidPayments: {
      paymentDate: formatDateForAPI(payDate),
      payments: [{ amount: amount }],
    },
  };
}

// ─── Helpers (Receipt-sheet specific) ─────────────────────────────────────────

/**
 * เพิ่มคอลัมน์ "เลขที่ PEAK" (I) ถ้ายังไม่มี
 */
function ensureReceiptHeader_(sheet) {
  const headerRow = CONFIG.RECEIPT_HEADER_ROW;
  const lastCol = sheet.getLastColumn();
  if (lastCol >= CONFIG.RECEIPT_COL.PEAK_DOC + 1) return;

  sheet.getRange(headerRow, CONFIG.RECEIPT_COL.PEAK_DOC + 1).setValue('เลขที่ PEAK');
}

/**
 * เขียนค่าเข้า Receipt sheet (1-indexed row, col)
 * +1 (header) +1 (0→1)
 */
function writeReceiptCell_(sheet, rowIndex, col, value) {
  sheet.getRange(rowIndex + CONFIG.RECEIPT_HEADER_ROW + 1, col + 1).setValue(value);
}

function buildReceiptDescription_(instType, invCode) {
  if (!instType) return `ค่างวด สัญญา ${invCode}`;
  const s = String(instType).trim();
  if (s.includes('ดาวน์')) return `เงินดาวน์ สัญญา ${invCode}`;
  if (s.includes('ปิด'))   return `ปิดยอด สัญญา ${invCode}`;
  const num = parseInstallmentNumber(s);
  if (num) return `ค่างวดที่ ${num} สัญญา ${invCode}`;
  return `${s} สัญญา ${invCode}`;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ─── Part 1 ส่วนเสริม: ค่าบริการเพิ่มเติม (อ่านจาก Sum sheet) ────────────────
// ⚠️ Sum sheet มีแค่ col SERVICE_FEE (N, index 13) — ไม่มีช่อง DATE/DOC/TYPE
//    → ใช้ วันที่ทำสัญญา (B) เป็น fallback date
//    → เลขที่ PEAK เขียนไปคอลัมน์ใหม่ (ถัดจาก DUE_DATE) อัตโนมัติ

function runPart1_ServiceFee(sheetName) {
  sheetName = sheetName || getCurrentSumSheetName();
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error(`ไม่พบ Sheet "${sheetName}"`);

  toast(`⏳ Part 1 ค่าบริการ — ${sheetName}`, 'FinFin');

  const svcDocCol = ensureSvcFeeHeader_(sheet);  // column index (0-based) สำหรับ OUTPUT
  const data = getSumData_(sheet);

  const eligible = [];
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const invCode = String(row[CONFIG.COL.INV] || '').trim();
    if (!invCode) continue;

    const feeAmt = parseAmount(row[CONFIG.COL.SERVICE_FEE]);
    if (feeAmt <= 0) continue;

    const existingDoc = String(row[svcDocCol] || '').trim();
    if (existingDoc && existingDoc !== CONFIG.PROCESSING_MARKER) continue;

    const feeDate = toDate(row[CONFIG.COL.CONTRACT_DATE]) || toDate(row[CONFIG.COL.DUE_DATE]);
    if (!feeDate) {
      logEntry('Part1-SVC', sheetName, i, invCode, 'SKIP', '', 'ไม่มีวันที่อ้างอิง');
      continue;
    }

    eligible.push({ rowIndex: i, invCode, feeAmt, feeDate });
  }

  if (eligible.length === 0) {
    const msg = 'Part 1 ค่าบริการ — ไม่มีรายการ';
    toast(msg, 'FinFin', 5);
    return msg;
  }

  eligible.sort((a, b) => compareDates(a.feeDate, b.feeDate));

  let ok = 0, err = 0;
  for (const item of eligible) {
    writeSumCell_(sheet, item.rowIndex, svcDocCol, CONFIG.PROCESSING_MARKER);
    try {
      const desc = `ค่าบริการเพิ่มเติม สัญญา ${item.invCode}`;
      const ref = buildReference(item.invCode, formatDateForAPI(item.feeDate), 'SVC');
      const payload = buildAllinonePayload(item.invCode, item.feeDate, item.feeAmt, desc, CONFIG.PMT_TRANSFER, ref);
      const res = callPeakAPI('post', '/Receipts/allinone', { peakReceipts: payload });
      const docNo = [res.taxInvoiceCode, res.receiptCode].filter(Boolean).join(' / ');
      writeSumCell_(sheet, item.rowIndex, svcDocCol, docNo);
      logEntry('Part1-SVC', sheetName, item.rowIndex, item.invCode, 'SUCCESS', docNo);
      ok++;
    } catch (e) {
      writeSumCell_(sheet, item.rowIndex, svcDocCol, '');
      logEntry('Part1-SVC', sheetName, item.rowIndex, item.invCode, 'ERROR', '', e.message);
      err++;
    }
  }

  const summary = `Part 1 ค่าบริการ — สร้าง: ${ok}, Error: ${err}`;
  toast(summary, 'FinFin', 10);
  Logger.log(summary);
  return summary;
}

function ensureSvcFeeHeader_(sheet) {
  const headerRow = CONFIG.SUM_HEADER_ROW;
  const lastCol = sheet.getLastColumn();
  const targetCol = CONFIG.COL.DUE_DATE + 1;  // R = หลัง Q (due_date)
  if (lastCol >= targetCol + 1) {
    // ตรวจว่ามี header "เลขที่ PEAK" แล้วไหม
    const existing = sheet.getRange(headerRow, targetCol + 1).getValue();
    if (!existing) sheet.getRange(headerRow, targetCol + 1).setValue('เลขที่ PEAK (ค่าบริการ)');
  } else {
    sheet.getRange(headerRow, targetCol + 1).setValue('เลขที่ PEAK (ค่าบริการ)');
  }
  return targetCol;
}

function getSumData_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= CONFIG.SUM_HEADER_ROW) return [];
  return sheet
    .getRange(CONFIG.SUM_HEADER_ROW + 1, 1, lastRow - CONFIG.SUM_HEADER_ROW, sheet.getLastColumn())
    .getValues();
}

function writeSumCell_(sheet, rowIndex, col, value) {
  sheet.getRange(rowIndex + CONFIG.SUM_HEADER_ROW + 1, col + 1).setValue(value);
}
