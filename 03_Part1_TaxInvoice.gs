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

  // ─── Time guard: GAS hard limit = 6 min. หยุดที่ 5 min เผื่อ cleanup ────────
  const startMs    = Date.now();
  const MAX_RUN_MS = 5 * 60 * 1000;
  const timeUp = () => (Date.now() - startMs) > MAX_RUN_MS;
  let stoppedEarly = false;

  // ─── First pass: collect raw items (no payloads yet) ─────────────────────
  const rawA    = [];  // Case A: allinone (payDate < dueDate)
  const rawBtax = [];  // Case B: tax invoice via queue
  const rawBrec = [];  // Case B: receipt via queue
  let countSkip = 0, countError = 0;
  const nameMap = {};

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

    writeReceiptCell_(sheet, i, CONFIG.RECEIPT_COL.PEAK_DOC, CONFIG.PROCESSING_MARKER);

    // ใช้เลขที่ smemove (IVF-YYMMDD-NNN) เป็น code ใน PEAK เพื่อ reconcile ได้ตรง
    const smemoveTaxRef = smemoveDoc.startsWith('IVF-') ? smemoveDoc : null;

    if (dueDate && compareDates(payDate, dueDate) < 0) {
      const ref = smemoveTaxRef || buildReference(invCode, installment || 'X', 'TAX');
      rawA.push({ rowIndex: i, invCode, payDate, amt, desc, ref });
    } else {
      const taxDate = dueDate || payDate;
      const refTax = smemoveTaxRef || buildReference(invCode, installment || 'X', 'TAX');
      const refRec = buildReference(invCode, installment || 'X', 'REC');
      rawBtax.push({ rowIndex: i, invCode, taxDate, amt, desc, ref: refTax });
      rawBrec.push({ rowIndex: i, invCode, payDate, amt, desc, ref: refRec });
    }
  }

  // ─── Sync contacts to PEAK before submission ─────────────────────────────
  {
    const batchCodes = {};
    [...rawA, ...rawBtax].forEach(x => {
      if (!batchCodes[x.invCode]) batchCodes[x.invCode] = nameMap[x.invCode] || '';
    });
    const n = Object.keys(batchCodes).length;
    if (n > 0) {
      toast(`⏳ Sync ${n} contacts...`, 'FinFin');
      ensureContactsBatch_(batchCodes);
    }
  }

  // ─── Fetch payment methods once ──────────────────────────────────────────
  let pmtMap = {};
  try {
    pmtMap = getPaymentMethodMap_();
    Logger.log('Payment methods: ' + JSON.stringify(pmtMap));
  } catch (e) {
    Logger.log('⚠️ ไม่สามารถดึง payment methods: ' + e.message);
  }

  // ─── Resolve contacts + build payloads ──────────────────────────────────
  // contact UUID จำเป็นสำหรับทุก endpoint (/receipts/allinone, /invoices/queue, /receipts/queue)
  const contactUuidCache = {};
  const resolvedA    = [];
  const resolvedBtax = [];

  // Case A — allinone
  for (const item of rawA) {
    if (timeUp()) { stoppedEarly = true; break; }
    const contactUuid = contactUuidCache[item.invCode] || getContactId_(item.invCode);
    if (!contactUuid) {
      writeReceiptCell_(sheet, item.rowIndex, CONFIG.RECEIPT_COL.PEAK_DOC, '');
      logEntry('Part1', sheetName, item.rowIndex, item.invCode, 'SKIP', '', 'ไม่พบ contactId — รัน Sync Contacts ก่อน');
      countSkip++;
      continue;
    }
    contactUuidCache[item.invCode] = contactUuid;
    const pmtInfo = pmtMap[CONFIG.PMT_TRANSFER] || pmtMap[CONFIG.PMT_CASH];
    if (!pmtInfo) {
      writeReceiptCell_(sheet, item.rowIndex, CONFIG.RECEIPT_COL.PEAK_DOC, '');
      logEntry('Part1', sheetName, item.rowIndex, item.invCode, 'SKIP', '', 'ไม่พบ payment method ใน PEAK — ตั้งค่า "โอนเงิน" ใน PEAK ก่อน');
      countSkip++;
      continue;
    }
    item.payload = buildAllinonePayload(
      item.invCode, contactUuid, item.payDate, item.amt, item.desc,
      pmtInfo.id, pmtInfo.code, item.ref,
    );
    resolvedA.push(item);
  }

  // Case B — invoices/queue
  if (!stoppedEarly) {
    for (const item of rawBtax) {
      if (timeUp()) { stoppedEarly = true; break; }
      const contactUuid = contactUuidCache[item.invCode] || getContactId_(item.invCode);
      if (!contactUuid) {
        writeReceiptCell_(sheet, item.rowIndex, CONFIG.RECEIPT_COL.PEAK_DOC, '');
        logEntry('Part1', sheetName, item.rowIndex, item.invCode, 'SKIP', '', 'ไม่พบ contactId — รัน Sync Contacts ก่อน');
        countSkip++;
        const recItem = rawBrec.find(r => r.rowIndex === item.rowIndex);
        if (recItem) writeReceiptCell_(sheet, recItem.rowIndex, CONFIG.RECEIPT_COL.PEAK_DOC, '');
        continue;
      }
      contactUuidCache[item.invCode] = contactUuid;
      item.payload = buildTaxInvoiceOnlyPayload(
        item.invCode, contactUuid, item.taxDate, item.amt, item.desc, item.ref,
      );
      resolvedBtax.push(item);
    }
  }

  let countA = 0, countB = 0;

  // ─── Submit Case A (one by one) ───────────────────────────────────────────
  for (const item of resolvedA) {
    if (timeUp()) { stoppedEarly = true; break; }
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

  // ─── Submit Case B tax (queue) ────────────────────────────────────────────
  if (!stoppedEarly && resolvedBtax.length > 0) {
    for (const chunk of chunkArray(resolvedBtax, CONFIG.BATCH_SIZE)) {
      if (timeUp()) { stoppedEarly = true; break; }
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

  // ─── Submit Case B receipt (queue) ───────────────────────────────────────
  const resolvedTaxRows = new Set(resolvedBtax.map(t => t.rowIndex));
  const resolvedBrec = rawBrec.filter(r => resolvedTaxRows.has(r.rowIndex));
  if (!stoppedEarly && resolvedBrec.length > 0) {
    const pmtInfo = pmtMap[CONFIG.PMT_TRANSFER] || pmtMap[CONFIG.PMT_CASH];
    for (const chunk of chunkArray(resolvedBrec, CONFIG.BATCH_SIZE)) {
      if (timeUp()) { stoppedEarly = true; break; }
      try {
        const payloads = chunk.map(x => {
          const cUuid = contactUuidCache[x.invCode] || '';
          return buildReceiptOnlyPayload(
            x.invCode, cUuid, x.payDate, x.amt, x.desc,
            pmtInfo ? pmtInfo.id : '', pmtInfo ? pmtInfo.code : '', x.ref,
          );
        });
        const res = callPeakAPI('post', '/receipts/queue',
          { PeakReceipts: { receipts: payloads } });
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

  const elapsed = Math.round((Date.now() - startMs) / 1000);
  const tail = stoppedEarly
    ? ` ⚠️ หยุดที่ ${elapsed}s ก่อนหมดเวลา — รันใหม่เพื่อทำต่อ`
    : ` (${elapsed}s)`;
  const summary = `Part 1 เสร็จ — Case A: ${countA}, Queue B: ${countB}, Skip: ${countSkip}, Error: ${countError}${tail}`;
  toast(summary, 'FinFin', 10);
  Logger.log(summary);
  return summary;
}

// ─── Payload Builders ─────────────────────────────────────────────────────────
// Format ยืนยันจาก debug Step 10a (2026-05-18): resCode=200 ✅
//   contact:{id,code}  istaxInvoice  taxStatus:1  accountCode:410101
//   paidPayments.payments:[{paymentMethod:{id,code}, amount}]

function buildAllinonePayload(invCode, contactUuid, payDate, amount, desc, pmtUuid, pmtCode, ref) {
  return {
    code:         ref,
    issuedDate:   formatDateForAPI(payDate),
    dueDate:      formatDateForAPI(payDate),
    contact:      { id: contactUuid, code: String(invCode) },
    istaxInvoice: 1,
    taxStatus:    1,  // 1=รวมภาษี: ยอดที่จ่ายคือ total รวม VAT แล้ว
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
      payments:    [{ paymentMethod: { id: pmtUuid, code: pmtCode }, amount: amount }],
    },
  };
}

function buildTaxInvoiceOnlyPayload(invCode, contactUuid, taxDate, amount, desc, ref) {
  return {
    code:         ref,
    issuedDate:   formatDateForAPI(taxDate),
    dueDate:      formatDateForAPI(taxDate),
    contact:      { id: contactUuid, code: String(invCode) },
    istaxInvoice: 1,
    taxStatus:    1,
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

function buildReceiptOnlyPayload(invCode, contactUuid, payDate, amount, desc, pmtUuid, pmtCode, ref) {
  return {
    code:         ref,
    issuedDate:   formatDateForAPI(payDate),
    dueDate:      formatDateForAPI(payDate),
    contact:      { id: contactUuid, code: String(invCode) },
    istaxInvoice: 0,
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
      payments:    [{ paymentMethod: { id: pmtUuid, code: pmtCode }, amount: amount }],
    },
  };
}

// ดึง payment methods ทั้งหมด คืน map: { [type]: { id, code } }
function getPaymentMethodMap_() {
  const res = callPeakAPI('get', '/paymentmethods', null, { page: 1 });
  const pms = res && res.PeakPaymentMethods && res.PeakPaymentMethods.paymentMethods;
  const map = {};
  if (Array.isArray(pms)) {
    pms.forEach(pm => { if (pm.type != null) map[pm.type] = { id: pm.id, code: pm.code }; });
  }
  return map;
}

// ─── Helpers (Receipt-sheet specific) ─────────────────────────────────────────

function ensureReceiptHeader_(sheet) {
  const headerRow = CONFIG.RECEIPT_HEADER_ROW;
  const lastCol = sheet.getLastColumn();
  if (lastCol >= CONFIG.RECEIPT_COL.PEAK_DOC + 1) return;
  sheet.getRange(headerRow, CONFIG.RECEIPT_COL.PEAK_DOC + 1).setValue('เลขที่ PEAK');
}

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

// ทดสอบ allinone 1 แถวด้วย production payload format ที่ยืนยันแล้ว
function debugPart1Row() {
  const sheetName = getCurrentReceiptSheetName();
  const dataRowIndex = 0;

  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) { Logger.log('ไม่พบ sheet: ' + sheetName); return; }

  const data = getReceiptData_(sheet);
  const row = data[dataRowIndex];
  if (!row) { Logger.log('ไม่พบ row index: ' + dataRowIndex); return; }

  const invCode = String(row[CONFIG.RECEIPT_COL.INV] || '').trim();
  const amt     = parseAmount(row[CONFIG.RECEIPT_COL.AMT]);
  const payDate = toDate(row[CONFIG.RECEIPT_COL.PAY_DATE]);
  const inst    = String(row[CONFIG.RECEIPT_COL.INST_TYPE] || '').trim();
  const desc    = buildReceiptDescription_(inst, invCode);

  Logger.log(`▼ Row ${dataRowIndex}: invCode=${invCode}, amt=${amt}, payDate=${payDate}`);

  const contactUuid = getContactId_(invCode);
  Logger.log('contactUuid: ' + contactUuid);
  if (!contactUuid) { Logger.log('⚠️ ไม่พบ contact — รัน Sync Contacts ก่อน'); return; }

  const pmtMap = getPaymentMethodMap_();
  Logger.log('pmtMap: ' + JSON.stringify(pmtMap));
  const pmtInfo = pmtMap[CONFIG.PMT_TRANSFER] || pmtMap[CONFIG.PMT_CASH];
  if (!pmtInfo) { Logger.log('⚠️ ไม่พบ payment method — ตั้งค่าใน PEAK ก่อน'); return; }

  const ref = 'DEBUG-PROD-' + Date.now();
  const payload = buildAllinonePayload(invCode, contactUuid, payDate, amt, desc, pmtInfo.id, pmtInfo.code, ref);
  Logger.log('Payload: ' + JSON.stringify(payload));

  const res = UrlFetchApp.fetch(CONFIG.BASE_URL + '/receipts/allinone', {
    method: 'post', headers: buildHeaders(), contentType: 'application/json',
    payload: JSON.stringify({ PeakReceipts: { receipts: [payload] } }),
    muteHttpExceptions: true,
  });
  Logger.log('HTTP: ' + res.getResponseCode());
  Logger.log('BODY: ' + res.getContentText());
}

// ─── Part 1 ส่วนเสริม: ค่าบริการเพิ่มเติม (อ่านจาก Sum sheet) ────────────────

function runPart1_ServiceFee(sheetName) {
  sheetName = sheetName || getCurrentSumSheetName();
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error(`ไม่พบ Sheet "${sheetName}"`);

  toast(`⏳ Part 1 ค่าบริการ — ${sheetName}`, 'FinFin');

  const svcDocCol = ensureSvcFeeHeader_(sheet);
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

  // ดึง payment method ก่อนวนลูป
  let pmtMapSvc = {};
  try { pmtMapSvc = getPaymentMethodMap_(); } catch (e) { Logger.log('pmtMap error: ' + e.message); }
  const pmtInfoSvc = pmtMapSvc[CONFIG.PMT_TRANSFER] || pmtMapSvc[CONFIG.PMT_CASH];

  let ok = 0, err = 0;
  for (const item of eligible) {
    writeSumCell_(sheet, item.rowIndex, svcDocCol, CONFIG.PROCESSING_MARKER);
    try {
      const contactUuid = getContactId_(item.invCode);
      if (!contactUuid) throw new Error('ไม่พบ contactId — รัน Sync Contacts ก่อน');
      if (!pmtInfoSvc) throw new Error('ไม่พบ payment method ใน PEAK');
      const desc = `ค่าบริการเพิ่มเติม สัญญา ${item.invCode}`;
      const ref = buildReference(item.invCode, formatDateForAPI(item.feeDate), 'SVC');
      const payload = buildAllinonePayload(
        item.invCode, contactUuid, item.feeDate, item.feeAmt, desc,
        pmtInfoSvc.id, pmtInfoSvc.code, ref,
      );
      const res = callPeakAPI('post', '/receipts/allinone', { PeakReceipts: { receipts: [payload] } });
      const rec = (res.PeakReceipts && res.PeakReceipts.receipts && res.PeakReceipts.receipts[0]) || res;
      const docNo = [rec.taxInvoiceCode || rec.code, rec.receiptCode].filter(Boolean).join(' / ');
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
  const targetCol = CONFIG.COL.DUE_DATE + 1;
  if (lastCol >= targetCol + 1) {
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
