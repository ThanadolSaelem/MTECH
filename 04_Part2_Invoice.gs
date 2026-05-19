/**
 * FinFin Automation — Part 2: ออกใบแจ้งหนี้ bulk (สัญญาใหม่)
 *
 * Source: Sum.MM.YYYY (contract list — new schema Apr 2026)
 *   COL.INV, CONTRACT_DATE, TITLE, NAME, CONTRACT_AMT,
 *   INSTALLMENT_N, INSTALLMENT_AMT, PAY_DAY, DOWN_OR_MONTHLY
 *
 * Filter:
 *   - INV ไม่ว่าง, CONTRACT_DATE ไม่ว่าง
 *   - CONTRACT_AMT + INSTALLMENT_N + INSTALLMENT_AMT ครบ
 *   - OUTPUT col (auto-added ถัดจาก DUE_DATE) ว่าง (idempotency)
 *
 * PEAK Endpoint: POST /Invoices/allinone (สร้าง + แตกงวด, ไม่มี queue)
 *
 * หมายเหตุ: Sum sheet มี DOWN_OR_MONTHLY = "ดาวน์" หรือยอดค่างวด
 *           เราเดาเงินดาวน์จากส่วนต่าง: DOWN = CONTRACT_AMT − (INSTALLMENT_AMT × INSTALLMENT_N)
 */

function runPart2_Invoice(sheetName) {
  preFlightChecks_();
  sheetName = sheetName || getCurrentSumSheetName();
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error(`ไม่พบ Sheet "${sheetName}"`);

  toast(`⏳ Part 2 ใบแจ้งหนี้ — ${sheetName}`, 'FinFin');

  const invDocCol = ensureInvoiceDocHeader_(sheet);
  const data = getSumData_(sheet);

  let countOk = 0, countSkip = 0, countError = 0;

  for (let i = 0; i < data.length; i++) {
    const row = data[i];

    const invCode = String(row[CONFIG.COL.INV] || '').trim();
    if (!invCode) continue;

    const contractDate = toDate(row[CONFIG.COL.CONTRACT_DATE]);
    if (!contractDate) continue;

    const existingDoc = String(row[invDocCol] || '').trim();
    if (existingDoc && existingDoc !== CONFIG.PROCESSING_MARKER) {
      countSkip++;
      continue;
    }

    const contractAmt     = parseAmount(row[CONFIG.COL.CONTRACT_AMT]);
    const numInstallments = parseInt(row[CONFIG.COL.INSTALLMENT_N]) || 0;
    const installmentAmt  = parseAmount(row[CONFIG.COL.INSTALLMENT_AMT]);
    const paymentDay      = parseInt(row[CONFIG.COL.PAY_DAY]) || 1;

    if (!contractAmt || !numInstallments || !installmentAmt) {
      logEntry('Part2', sheetName, i, invCode, 'SKIP', '', 'ข้อมูลยอด/จำนวนงวด/ค่างวดไม่ครบ');
      countSkip++;
      continue;
    }

    const downPayment = Math.max(0, contractAmt - (installmentAmt * numInstallments));
    const dueDates    = calculateDueDates(contractDate, paymentDay, numInstallments);
    const customerName = `${String(row[CONFIG.COL.TITLE] || '').trim()}${String(row[CONFIG.COL.NAME] || '').trim()}`.trim();

    writeSumCell_(sheet, i, invDocCol, CONFIG.PROCESSING_MARKER);

    try {
      // ensure contact exists + resolve UUID (Part 1 format: contact:{id,code})
      ensureContactsBatch_({ [invCode]: customerName });
      const contactUuid = getContactId_(invCode);
      if (!contactUuid) throw new Error('ไม่พบ contactId — รัน Sync Contacts ก่อน');

      const payload = buildInvoiceAllInOnePayload(
        invCode, contactUuid, contractDate, downPayment, installmentAmt,
        numInstallments, contractAmt, dueDates, customerName
      );
      const res = callPeakAPI('post', '/invoices/allinone', { PeakInvoices: { invoices: [payload] } });
      const inv = (res.PeakInvoices && res.PeakInvoices.invoices && res.PeakInvoices.invoices[0]) || res;
      const docNo = inv.invoiceCode || inv.code || JSON.stringify(res).substring(0, 80);
      writeSumCell_(sheet, i, invDocCol, docNo);
      logEntry('Part2', sheetName, i, invCode, 'SUCCESS', docNo);
      countOk++;
    } catch (e) {
      writeSumCell_(sheet, i, invDocCol, '');
      logEntry('Part2', sheetName, i, invCode, 'ERROR', '', e.message);
      countError++;
    }
  }

  const summary = `Part 2 เสร็จ — สร้าง: ${countOk}, ข้าม: ${countSkip}, Error: ${countError}`;
  toast(summary, 'FinFin', 10);
  Logger.log(summary);
  return summary;
}

// ─── Payload Builder ──────────────────────────────────────────────────────────

function buildInvoiceAllInOnePayload(
  invCode, contactUuid, contractDate, downPayment, installmentAmt,
  numInstallments, contractAmt, dueDates, customerName
) {
  const products = [];

  if (downPayment > 0) {
    products.push({
      accountCode: CONFIG.ACCOUNT_CODE_SALES,
      description: `เงินดาวน์ สัญญา ${invCode}`,
      quantity:    1,
      price:       downPayment,
      vatType:     CONFIG.VAT_TYPE_7,
      dueDate:     formatDateForAPI(contractDate),
    });
  }

  if (numInstallments > 0) {
    const lastDueDate = dueDates[dueDates.length - 1] || contractDate;
    products.push({
      accountCode: CONFIG.ACCOUNT_CODE_SALES,
      description: `ค่างวด ${numInstallments} งวด งวดละ ${installmentAmt.toLocaleString()} บาท สัญญา ${invCode}`,
      quantity:    numInstallments,
      price:       installmentAmt,
      vatType:     CONFIG.VAT_TYPE_7,
      dueDate:     formatDateForAPI(lastDueDate),
    });
  }

  return {
    code:         buildReference(invCode, 'ALL', 'INV'),
    issuedDate:   formatDateForAPI(contractDate),
    dueDate:      formatDateForAPI(dueDates[dueDates.length - 1] || contractDate),
    contact:      { id: contactUuid, code: String(invCode) },
    istaxInvoice: 1,
    taxStatus:    1,
    remark:       `ใบแจ้งหนี้ สัญญา ${invCode}${customerName ? ` — ${customerName}` : ''}`,
    products,
  };
}

// ─── Sheet helpers (Sum-specific) ─────────────────────────────────────────────

function ensureInvoiceDocHeader_(sheet) {
  const headerRow = CONFIG.SUM_HEADER_ROW;
  const targetCol = CONFIG.COL.DUE_DATE + 2;  // เว้น col เดียวจาก SVC fee doc
  const currentHeader = sheet.getRange(headerRow, targetCol + 1).getValue();
  if (!currentHeader) {
    sheet.getRange(headerRow, targetCol + 1).setValue('เลขที่ใบแจ้งหนี้ PEAK');
  }
  return targetCol;
}

// getSumData_ / writeSumCell_ / calculateDueDates อยู่ใน Part 1 / Utils อยู่แล้ว

function calculateDueDates(startDate, paymentDay, numMonths) {
  if (!startDate || isNaN(startDate.getTime())) return [];

  const dates = [];
  let firstDueMonth = startDate.getMonth();
  let firstDueYear  = startDate.getFullYear();

  if (startDate.getDate() >= paymentDay) {
    firstDueMonth += 1;
    if (firstDueMonth > 11) { firstDueMonth = 0; firstDueYear += 1; }
  }

  for (let n = 0; n < numMonths; n++) {
    let m = firstDueMonth + n;
    let y = firstDueYear;
    while (m > 11) { m -= 12; y += 1; }
    const lastDay = new Date(y, m + 1, 0).getDate();
    dates.push(new Date(y, m, Math.min(paymentDay, lastDay), 12, 0, 0));
  }
  return dates;
}
