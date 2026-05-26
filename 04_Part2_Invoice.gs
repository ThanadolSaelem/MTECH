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
  const sheet = getSheetByNameSmart_(ss, sheetName);
  if (!sheet) throw new Error(`ไม่พบ Sheet "${sheetName}"`);

  toast(`⏳ Part 2 ใบแจ้งหนี้ — ${sheetName}`, 'FinFin');

  const invDocCol = ensureInvoiceDocHeader_(sheet);
  const data = getSumData_(sheet);

  let countOk = 0, countSkip = 0, countError = 0;

  const guard = makeTimeGuard_(5);
  let stoppedEarly = false, quotaHit = false;

  for (let i = 0; i < data.length; i++) {
    if (guard.expired()) { stoppedEarly = true; break; }
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
    const title = String(row[CONFIG.COL.TITLE] || '').trim();
    const rawName = String(row[CONFIG.COL.NAME] || '').trim();
    const customerName = rawName.startsWith(title) ? rawName : (title + rawName).trim();

    writeSumCell_(sheet, i, invDocCol, CONFIG.PROCESSING_MARKER);

    try {
      // ensure contact exists — UUID optional (PEAK auto-creates from code+name if needed)
      ensureContactsBatch_({ [invCode]: customerName });
      const contactUuid = getContactId_(invCode);

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
      const kind = classifyError_(e);
      if (kind === 'duplicate') {
        // ใบแจ้งหนี้นี้มีใน PEAK แล้วจากรอบก่อน — กู้เลขเอกสารคืน
        const recovered = tryRecoverPeakDoc_('/invoices', buildReference(invCode, 'ALL', 'INV'));
        if (recovered) {
          writeSumCell_(sheet, i, invDocCol, recovered);
          logEntry('Part2', sheetName, i, invCode, 'SUCCESS', recovered, 'กู้เลขเอกสารซ้ำ');
          countOk++;
        } else {
          writeSumCell_(sheet, i, invDocCol, CONFIG.DUPLICATE_MARKER);
          logEntry('Part2', sheetName, i, invCode, 'WARN', CONFIG.DUPLICATE_MARKER,
            'ใบแจ้งหนี้มีใน PEAK แล้ว — ค้นหาเลขที่ใน PEAK แล้วอัปเดตเซลล์ด้วยตนเอง');
        }
      } else if (kind === 'quota') {
        writeSumCell_(sheet, i, invDocCol, '');
        logEntry('Part2', sheetName, i, invCode, 'WARN', '', `หยุดชั่วคราว (quota): ${e.message}`);
        quotaHit = true;
        stoppedEarly = true;
        break;
      } else {
        writeSumCell_(sheet, i, invDocCol, '');
        logEntry('Part2', sheetName, i, invCode, 'ERROR', '', e.message);
        countError++;
      }
    }
  }

  let tail = '';
  if (stoppedEarly) {
    scheduleContinuation_('runPart2_Invoice', sheetName, countOk > 0);
    tail = quotaHit
      ? ' ⏸️ หยุดชั่วคราว (โควตา) — ทำต่ออัตโนมัติใน 15 นาที'
      : ' ⏸️ หยุดกันหมดเวลา — ทำต่ออัตโนมัติใน 15 นาที';
  } else {
    clearContinuation_('runPart2_Invoice');
  }
  const summary = `Part 2 เสร็จ — สร้าง: ${countOk}, ข้าม: ${countSkip}, Error: ${countError}${tail}`;
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
    contact:      contactUuid
      ? { id: contactUuid, code: String(invCode), name: customerName }
      : { code: String(invCode), name: customerName },
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
