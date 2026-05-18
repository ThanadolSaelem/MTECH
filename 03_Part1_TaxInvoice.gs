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
  const startMs   = Date.now();
  const MAX_RUN_MS = 5 * 60 * 1000;
  const timeUp = () => (Date.now() - startMs) > MAX_RUN_MS;
  let stoppedEarly = false;

  const batchA = [];     // Case A allinone
  const batchB_tax = []; // Case B tax invoice
  const batchB_rec = []; // Case B receipt
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
    const payType = CONFIG.PMT_TRANSFER;

    writeReceiptCell_(sheet, i, CONFIG.RECEIPT_COL.PEAK_DOC, CONFIG.PROCESSING_MARKER);

    // ใช้เลขที่ smemove (IVF-YYMMDD-NNN) เป็น code ใน PEAK เพื่อ reconcile ได้ตรง
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

  // ─── Resolve contacts before submission ───────────────────────────────────
  // /receipts/allinone ใช้ contactCode (contact ต้องมีอยู่ใน PEAK แล้ว — ผ่าน ensureContactsBatch_)
  // /invoices/queue   ต้องการ contactId (UUID) — lazy GET ถ้า cache มีแค่ 1
  // /receipts/queue   ใช้ contactCode — batchB_rec ไม่ต้องแก้
  const resolvedA    = [];
  const resolvedBtax = [];

  // Case A — allinone: ตรวจ cache เท่านั้น (ไม่ lazy GET → เร็ว)
  for (const item of batchA) {
    if (timeUp()) { stoppedEarly = true; break; }
    if (isContactSynced_(item.invCode)) {
      resolvedA.push(item);  // payload คง contactCode ไว้ — allinone ใช้ contactCode
    } else {
      writeReceiptCell_(sheet, item.rowIndex, CONFIG.RECEIPT_COL.PEAK_DOC, '');
      logEntry('Part1', sheetName, item.rowIndex, item.invCode, 'SKIP', '', 'Contact ยังไม่ sync — รัน Sync Contacts ก่อน');
      countSkip++;
    }
  }
  // Case B — invoices/queue: ต้องการ contactId (UUID)
  if (!stoppedEarly) {
    for (const item of batchB_tax) {
      if (timeUp()) { stoppedEarly = true; break; }
      const cid = getContactId_(item.invCode);
      if (cid) {
        item.payload.contactId = cid;
        delete item.payload.contactCode;
        resolvedBtax.push(item);
      } else {
        writeReceiptCell_(sheet, item.rowIndex, CONFIG.RECEIPT_COL.PEAK_DOC, '');
        logEntry('Part1', sheetName, item.rowIndex, item.invCode, 'SKIP', '', 'ไม่พบ contactId — รัน Sync Contacts ก่อนแล้วลองใหม่');
        countSkip++;
        const recItem = batchB_rec.find(r => r.rowIndex === item.rowIndex);
        if (recItem) writeReceiptCell_(sheet, recItem.rowIndex, CONFIG.RECEIPT_COL.PEAK_DOC, '');
      }
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

  // ─── Submit Case B (queue) ────────────────────────────────────────────────
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
  const resolvedTaxRows = new Set(resolvedBtax.map(t => t.rowIndex));
  const resolvedBrec = batchB_rec.filter(r => resolvedTaxRows.has(r.rowIndex));
  if (!stoppedEarly && resolvedBrec.length > 0) {
    for (const chunk of chunkArray(resolvedBrec, CONFIG.BATCH_SIZE)) {
      if (timeUp()) { stoppedEarly = true; break; }
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
      paymentDate:    formatDateForAPI(payDate),
      paymentMethods: [{ type: payType, amount: amount }],
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

/**
 * ทดสอบ allinone กับ 1 แถวจริงจาก Receipt sheet แล้ว log raw response
 * Flow: (1) GET contact, (2) POST allinone ด้วย contactCode, (3) ถ้า fail → retry ด้วย contactId UUID
 */
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

  // ─── Step 1: ตรวจ contact ใน PEAK ────────────────────────────────────────
  Logger.log('─── Step 1: GET /contacts?code=' + invCode + ' ───');
  let contactUuid = null;
  try {
    const cRes = callPeakAPI('get', '/contacts', null, { code: invCode });
    const cs = cRes && cRes.PeakContacts && cRes.PeakContacts.contacts;
    const c = Array.isArray(cs) ? cs[0] : cs;
    contactUuid = c && c.id;
    Logger.log('Contact found: ' + JSON.stringify({ id: c && c.id, code: c && c.code, name: c && c.name }));
  } catch (e) {
    Logger.log('Contact GET error: ' + e.message);
  }

  // ─── Step 2: POST allinone ด้วย contactCode ──────────────────────────────
  const refA = 'DEBUG-A-' + invCode + '-' + Date.now();
  const payloadA = buildAllinonePayload(invCode, payDate, amt, desc, CONFIG.PMT_TRANSFER, refA);
  Logger.log('─── Step 2: POST allinone ด้วย contactCode ───');
  Logger.log('Payload A: ' + JSON.stringify(payloadA));
  const resA = UrlFetchApp.fetch(CONFIG.BASE_URL + '/receipts/allinone', {
    method: 'post', headers: buildHeaders(), contentType: 'application/json',
    payload: JSON.stringify({ PeakReceipts: { receipts: [payloadA] } }),
    muteHttpExceptions: true,
  });
  Logger.log('HTTP A: ' + resA.getResponseCode());
  Logger.log('BODY A: ' + resA.getContentText());

  // ─── Step 3: ถ้ามี UUID → retry ด้วย contactId ──────────────────────────
  if (contactUuid) {
    const refB = 'DEBUG-B-' + invCode + '-' + Date.now();
    const payloadB = buildAllinonePayload(invCode, payDate, amt, desc, CONFIG.PMT_TRANSFER, refB);
    delete payloadB.contactCode;
    payloadB.contactId = contactUuid;
    Logger.log('─── Step 3: POST allinone ด้วย contactId (UUID) ───');
    Logger.log('Payload B: ' + JSON.stringify(payloadB));
    const resB = UrlFetchApp.fetch(CONFIG.BASE_URL + '/receipts/allinone', {
      method: 'post', headers: buildHeaders(), contentType: 'application/json',
      payload: JSON.stringify({ PeakReceipts: { receipts: [payloadB] } }),
      muteHttpExceptions: true,
    });
    Logger.log('HTTP B: ' + resB.getResponseCode());
    Logger.log('BODY B: ' + resB.getContentText());
  } else {
    Logger.log('⚠️ ไม่มี contactUuid → ข้าม Step 3 (ต้อง POST /contacts/ ก่อน)');
  }

  // ─── Step 4: wrapper format เดิม (lowercase + single object) ────────────
  const refC = 'DEBUG-C-' + invCode + '-' + Date.now();
  const payloadC = buildAllinonePayload(invCode, payDate, amt, desc, CONFIG.PMT_TRANSFER, refC);
  Logger.log('─── Step 4: POST allinone ด้วย { peakReceipts: <single> } ───');
  Logger.log('Payload C: ' + JSON.stringify(payloadC));
  const resC = UrlFetchApp.fetch(CONFIG.BASE_URL + '/receipts/allinone', {
    method: 'post', headers: buildHeaders(), contentType: 'application/json',
    payload: JSON.stringify({ peakReceipts: payloadC }),
    muteHttpExceptions: true,
  });
  Logger.log('HTTP C: ' + resC.getResponseCode());
  Logger.log('BODY C: ' + resC.getContentText());

  // ─── Step 5: nested contact object ─────────────────────────────────────
  if (contactUuid) {
    const refD = 'DEBUG-D-' + invCode + '-' + Date.now();
    const payloadD = buildAllinonePayload(invCode, payDate, amt, desc, CONFIG.PMT_TRANSFER, refD);
    delete payloadD.contactCode;
    payloadD.contact = { id: contactUuid, code: invCode };
    Logger.log('─── Step 5: POST allinone ด้วย nested contact{id,code} ───');
    Logger.log('Payload D: ' + JSON.stringify(payloadD));
    const resD = UrlFetchApp.fetch(CONFIG.BASE_URL + '/receipts/allinone', {
      method: 'post', headers: buildHeaders(), contentType: 'application/json',
      payload: JSON.stringify({ PeakReceipts: { receipts: [payloadD] } }),
      muteHttpExceptions: true,
    });
    Logger.log('HTTP D: ' + resD.getResponseCode());
    Logger.log('BODY D: ' + resD.getContentText());
  }

  // ─── Step 6: POSTMAN-CORRECT format (istaxInvoice + payments + paymentMethodId) ──
  Logger.log('─── Step 6: GET /paymentmethods เพื่อหา UUID ของ transfer ───');
  let pmtUuid = null;
  try {
    const pmRes = callPeakAPI('get', '/paymentmethods', null, { page: 1 });
    const pms = pmRes && pmRes.PeakPaymentMethods && pmRes.PeakPaymentMethods.paymentMethods;
    Logger.log('PaymentMethods: ' + JSON.stringify(pms));
    if (Array.isArray(pms) && pms.length > 0) {
      const transfer = pms.find(p => p.type === 8) || pms.find(p => /transfer|โอน/i.test(p.name || '')) || pms[0];
      pmtUuid = transfer && (transfer.id || transfer.paymentMethodId);
      Logger.log('Selected paymentMethod: ' + JSON.stringify({ id: pmtUuid, name: transfer && transfer.name, type: transfer && transfer.type }));
    }
  } catch (e) {
    Logger.log('GET /paymentmethods error: ' + e.message);
  }

  if (contactUuid && pmtUuid) {
    const refE = 'DEBUG-E-' + invCode + '-' + Date.now();
    const payloadE = {
      code:          refE,
      issuedDate:    formatDateForAPI(payDate),
      dueDate:       formatDateForAPI(payDate),
      contactId:     contactUuid,
      istaxInvoice:  1,
      remark:        desc,
      products: [{
        accountCode: CONFIG.ACCOUNT_CODE_SALES,
        description: desc,
        quantity:    1,
        price:       amt,
        vatType:     CONFIG.VAT_TYPE_7,
      }],
      paidPayments: {
        paymentDate: formatDateForAPI(payDate),
        payments: [{ paymentMethodId: pmtUuid, amount: amt }],
      },
    };
    Logger.log('─── Step 6: POST allinone ด้วย Postman-correct format (contactId flat) ───');
    Logger.log('Payload E: ' + JSON.stringify(payloadE));
    const resE = UrlFetchApp.fetch(CONFIG.BASE_URL + '/receipts/allinone', {
      method: 'post', headers: buildHeaders(), contentType: 'application/json',
      payload: JSON.stringify({ PeakReceipts: { receipts: [payloadE] } }),
      muteHttpExceptions: true,
    });
    Logger.log('HTTP E: ' + resE.getResponseCode());
    Logger.log('BODY E: ' + resE.getContentText());
  } else {
    Logger.log('⚠️ ข้าม Step 6: contactUuid=' + contactUuid + ', pmtUuid=' + pmtUuid);
  }

  // ─── Step 7: รวม nested contact (Step 5) + istaxInvoice + payments UUID (Step 6) ──
  // Step 5: contact:{id,code} แก้ "Missing Contact Data" → เปลี่ยนเป็น "Missing Payment Data"
  // Step 6: payments.paymentMethodId UUID ถูกต้อง แต่ใช้ contactId flat → ยัง "Missing Contact Data"
  // Step 7: รวมทั้งสองเข้าด้วยกัน → ควรได้ 200 หรือ error อื่น
  if (contactUuid && pmtUuid) {
    const refF = 'DEBUG-F-' + invCode + '-' + Date.now();
    const payloadF = {
      code:         refF,
      issuedDate:   formatDateForAPI(payDate),
      dueDate:      formatDateForAPI(payDate),
      contact:      { id: contactUuid, code: invCode },
      istaxInvoice: 1,
      remark:       desc,
      products: [{
        accountCode: CONFIG.ACCOUNT_CODE_SALES,
        description: desc,
        quantity:    1,
        price:       amt,
        vatType:     CONFIG.VAT_TYPE_7,
      }],
      paidPayments: {
        paymentDate: formatDateForAPI(payDate),
        payments: [{ paymentMethodId: pmtUuid, amount: amt }],
      },
    };
    Logger.log('─── Step 7: POST allinone — nested contact{id,code} + istaxInvoice + payments UUID ───');
    Logger.log('Payload F: ' + JSON.stringify(payloadF));
    const resF = UrlFetchApp.fetch(CONFIG.BASE_URL + '/receipts/allinone', {
      method: 'post', headers: buildHeaders(), contentType: 'application/json',
      payload: JSON.stringify({ PeakReceipts: { receipts: [payloadF] } }),
      muteHttpExceptions: true,
    });
    Logger.log('HTTP F: ' + resF.getResponseCode());
    Logger.log('BODY F: ' + resF.getContentText());
  } else {
    Logger.log('⚠️ ข้าม Step 7: contactUuid=' + contactUuid + ', pmtUuid=' + pmtUuid);
  }

  // ─── Step 8: ทดลอง payment method format ต่างๆ — Step 7 ผ่าน contact แล้ว เหลือ payment method ──
  // Step 7 result: "Missing Payment Method Data At Payment [1]" → paymentMethodId alone ไม่พอ
  // ตามรูปแบบ contact (nested {id,code}) ลอง 4 รูปแบบหา format ที่ถูก
  if (contactUuid && pmtUuid) {
    const pmtCode = 'CSH001';
    const pmtType = 1;
    const baseProducts = [{
      accountCode: CONFIG.ACCOUNT_CODE_SALES,
      description: desc, quantity: 1, price: amt, vatType: CONFIG.VAT_TYPE_7,
    }];
    const baseContact = { id: contactUuid, code: invCode };
    const dateStr = formatDateForAPI(payDate);

    const variants = [
      {
        name: '8a: paymentMethod nested {id,code}',
        paymentObj: { paymentMethod: { id: pmtUuid, code: pmtCode }, amount: amt },
      },
      {
        name: '8b: paymentMethod nested {id,code,type}',
        paymentObj: { paymentMethod: { id: pmtUuid, code: pmtCode, type: pmtType }, amount: amt },
      },
      {
        name: '8c: flat paymentMethodId+Code+Type',
        paymentObj: { paymentMethodId: pmtUuid, paymentMethodCode: pmtCode, paymentMethodType: pmtType, amount: amt },
      },
      {
        name: '8d: flat type+id (no Code)',
        paymentObj: { type: pmtType, paymentMethodId: pmtUuid, amount: amt },
      },
    ];

    for (let k = 0; k < variants.length; k++) {
      const v = variants[k];
      const refX = 'DEBUG-' + String.fromCharCode(71 + k) + '-' + invCode + '-' + Date.now();
      const payloadX = {
        code:         refX,
        issuedDate:   dateStr,
        dueDate:      dateStr,
        contact:      baseContact,
        istaxInvoice: 1,
        remark:       desc,
        products:     baseProducts,
        paidPayments: { paymentDate: dateStr, payments: [v.paymentObj] },
      };
      Logger.log('─── Step ' + v.name + ' ───');
      Logger.log('Payload: ' + JSON.stringify(payloadX));
      const resX = UrlFetchApp.fetch(CONFIG.BASE_URL + '/receipts/allinone', {
        method: 'post', headers: buildHeaders(), contentType: 'application/json',
        payload: JSON.stringify({ PeakReceipts: { receipts: [payloadX] } }),
        muteHttpExceptions: true,
      });
      Logger.log('HTTP ' + v.name + ': ' + resX.getResponseCode());
      Logger.log('BODY ' + v.name + ': ' + resX.getContentText());
    }
  } else {
    Logger.log('⚠️ ข้าม Step 8: contactUuid=' + contactUuid + ', pmtUuid=' + pmtUuid);
  }

  // ─── Step 9: account code 410000 ไม่มีในระบบ → GET list แล้วลองหลาย code ──
  // Step 8a/8b ผ่าน payment method (nested paymentMethod{id,code}) แล้ว
  // เหลือ accountCode — 410000 ไม่ valid; PEAK doc แนะนำ 410101 (ขาย), 410301 (บริการ)
  Logger.log('─── Step 9: GET /dailyjournals/accountcode ───');
  try {
    const acRes = callPeakAPI('get', '/dailyjournals/accountcode', null, { page: 1 });
    Logger.log('AccountCodes (raw): ' + JSON.stringify(acRes).slice(0, 2000));
  } catch (e) {
    Logger.log('GET accountcode error: ' + e.message);
  }

  if (contactUuid && pmtUuid) {
    const codesToTry = ['410101', '410301', '410201', '410302', '410000'];
    for (const ac of codesToTry) {
      const refY = 'DEBUG-AC-' + ac + '-' + Date.now();
      const payloadY = {
        code:         refY,
        issuedDate:   formatDateForAPI(payDate),
        dueDate:      formatDateForAPI(payDate),
        contact:      { id: contactUuid, code: invCode },
        istaxInvoice: 1,
        remark:       desc,
        products: [{
          accountCode: ac,
          description: desc, quantity: 1, price: amt, vatType: CONFIG.VAT_TYPE_7,
        }],
        paidPayments: {
          paymentDate: formatDateForAPI(payDate),
          payments: [{ paymentMethod: { id: pmtUuid, code: 'CSH001' }, amount: amt }],
        },
      };
      Logger.log('─── Step 9 accountCode=' + ac + ' ───');
      const resY = UrlFetchApp.fetch(CONFIG.BASE_URL + '/receipts/allinone', {
        method: 'post', headers: buildHeaders(), contentType: 'application/json',
        payload: JSON.stringify({ PeakReceipts: { receipts: [payloadY] } }),
        muteHttpExceptions: true,
      });
      Logger.log('HTTP 9-' + ac + ': ' + resY.getResponseCode());
      Logger.log('BODY 9-' + ac + ': ' + resY.getContentText());
    }
  }
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
