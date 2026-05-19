/**
 * FinFin Automation — Poll Queue Results & Write Back to Sheet
 *
 * Unified meta shape (all docTypes):
 *   { rowIndex, invCode, docType, targetSheet, targetCol, headerOffset }
 *
 * docType meanings (for concatenation logic only):
 *   TAX — ใบกำกับภาษี (Case B Part 1) → Receipt.PEAK_DOC
 *   REC — ใบเสร็จ     (Case B Part 1) → Receipt.PEAK_DOC (append "TAX / REC")
 *   FEE — ใบเสร็จค่าปรับ (Part 3)     → SCB.FEE_DOC
 *
 * Trigger: time-based trigger ทุก 5 นาที (ตั้งใน 08_Menu.gs)
 */

// ─── Main Poll Function (เรียกจาก Trigger) ───────────────────────────────────

function pollAllQueues() {
  pollQueueType_('invoice');
  pollQueueType_('receipt');
  pollQueueType_('receipt_fee');
}

function pollQueueType_(queueType) {
  const entries = getQueueEntries(queueType);
  if (entries.length === 0) return;

  Logger.log(`Poll ${queueType}: ${entries.length} queue(s) pending`);

  const endpoint = queueType.startsWith('receipt') ? '/Receipts/queue' : '/Invoices/queue';

  for (const entry of entries) {
    try {
      const res = callPeakAPI('get', endpoint, null, { queueId: entry.queueId });
      const status = (res.status || '').toLowerCase();

      if (status === 'processing' || status === 'pending' || status === '') {
        Logger.log(`Queue ${entry.queueId} still processing...`);
        continue;
      }

      if (status === 'failed' || status === 'error') {
        logEntry(queueType.toUpperCase(), entry.sheetName, -1,
          'BATCH', 'ERROR', entry.queueId, `Queue failed: ${JSON.stringify(res).substring(0, 200)}`);
        deleteQueueEntry(entry.key);
        continue;
      }

      const results = res.results || res.data || null;
      if (Array.isArray(results)) {
        writeQueueResults_(queueType, entry, results);
        deleteQueueEntry(entry.key);
      } else {
        const ageHours = (Date.now() - Number(entry.savedAt || 0)) / 3600000;
        if (ageHours > 2) {
          logEntry(queueType.toUpperCase(), entry.sheetName, -1, 'BATCH', 'ERROR',
            entry.queueId, `Queue response format ไม่รู้จัก (timeout 2h): ${JSON.stringify(res).substring(0, 200)}`);
          deleteQueueEntry(entry.key);
        } else {
          Logger.log(`Queue ${entry.queueId} unexpected response format, will retry. Age: ${ageHours.toFixed(1)}h`);
        }
      }
    } catch (e) {
      Logger.log(`Poll error for queue ${entry.queueId}: ${e.message}`);
      // HTTP 400 = permanent failure (bad request, limit exceeded, etc.) → ลบทิ้ง
      if (e.message.includes('400') || e.message.includes('Transaction Limit')) {
        logEntry(queueType.toUpperCase(), entry.sheetName, -1, 'BATCH', 'ERROR',
          entry.queueId, `Queue ถูกยกเลิก (permanent): ${e.message}`);
        deleteQueueEntry(entry.key);
      }
    }
  }
}

// ─── Write Results Back to Sheet ─────────────────────────────────────────────

function writeQueueResults_(queueType, entry, results) {
  const ss = SpreadsheetApp.openById(getSpreadsheetId());

  results.forEach((result, idx) => {
    const meta = entry.meta[idx];
    if (!meta) return;

    const docCode = result.code || result.documentCode || result.invoiceCode ||
                    result.receiptCode || result.taxInvoiceCode || '';
    const docStatus = (result.status || '').toLowerCase();

    const targetSheetName = meta.targetSheet || entry.sheetName;
    const targetCol       = meta.targetCol;
    const headerOffset    = meta.headerOffset;
    const sheet = ss.getSheetByName(targetSheetName);

    if (!sheet || targetCol === undefined || headerOffset === undefined) {
      logEntry(queueType.toUpperCase(), entry.sheetName, meta.rowIndex, meta.invCode,
        'ERROR', '', `meta ไม่สมบูรณ์: sheet=${targetSheetName}, col=${targetCol}, offset=${headerOffset}`);
      return;
    }

    const actualRow = meta.rowIndex + headerOffset + 1;
    const cellRange = sheet.getRange(actualRow, targetCol + 1);

    if (docStatus === 'failed' || docStatus === 'error' || !docCode) {
      const errMsg = result.message || result.error || 'ไม่มี docCode ในผลลัพธ์';
      // Clear PROCESSING marker (แต่สำหรับ REC อย่าแตะ เพราะ TAX อาจสำเร็จแล้ว)
      if (meta.docType !== 'REC') cellRange.setValue('');
      logEntry(queueType.toUpperCase(), entry.sheetName, meta.rowIndex, meta.invCode,
        'ERROR', '', errMsg);
      return;
    }

    // REC: append ต่อจาก TAX code ที่อาจมีอยู่แล้วในเซลล์เดียวกัน
    if (meta.docType === 'REC') {
      const existing = String(cellRange.getValue() || '').trim();
      const merged = existing && existing !== CONFIG.PROCESSING_MARKER
        ? `${existing} / ${docCode}`
        : docCode;
      cellRange.setValue(merged);
    } else {
      cellRange.setValue(docCode);
    }

    logEntry(queueType.toUpperCase(), entry.sheetName, meta.rowIndex, meta.invCode,
      'SUCCESS', docCode);
  });
}

// ─── Manual Poll (เรียกจาก Menu) ─────────────────────────────────────────────

function manualPollQueues() {
  toast('⏳ กำลัง Poll Queue Results...', 'FinFin');
  try {
    pollAllQueues();
    toast('✅ Poll เสร็จแล้ว ตรวจ Log Sheet ได้เลย', 'FinFin', 8);
  } catch (e) {
    toast(`❌ Poll Error: ${e.message}`, 'FinFin', 10);
    throw e;
  }
}

// ─── Queue Status Summary ─────────────────────────────────────────────────────

function showQueueStatus() {
  const inv = getQueueEntries('invoice');
  const rec = getQueueEntries('receipt');
  const fee = getQueueEntries('receipt_fee');
  const total = inv.length + rec.length + fee.length;

  const msg = total === 0
    ? 'ไม่มี Queue รอผลอยู่'
    : `Queue รอผล:\n• Invoice: ${inv.length}\n• Receipt: ${rec.length}\n• ค่าปรับ: ${fee.length}\n\nรวม: ${total} queue`;

  SpreadsheetApp.getUi().alert('Queue Status', msg, SpreadsheetApp.getUi().ButtonSet.OK);
}
