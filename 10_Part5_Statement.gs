/**
 * FinFin Automation — Part 5: ตรวจ Bank Statement
 *
 * Auto-detect 2 SCB formats:
 *   A) RAW bank CSV   (16 cols, header row 1, Note col 15)
 *   B) ENHANCED sheet (21+ cols, header row 7-8, Note col 4)
 *
 * Match Flow:
 *   1. Detect SCB format → pick column map + header row
 *   2. Extract INV code จาก Note
 *   3. Lookup ใน Receipt sheet (source of truth)
 *   4. Score match by amount + date → build report
 */

function runPart5_StatementMatch(statementSheetName, receiptSheetName) {
  statementSheetName = statementSheetName || getCurrentStatementSheetName();
  receiptSheetName   = receiptSheetName   || getCurrentReceiptSheetName();

  const ss = SpreadsheetApp.openById(getSpreadsheetId());

  const stmtSheet = ss.getSheetByName(statementSheetName);
  if (!stmtSheet) throw new Error(`ไม่พบ Sheet "${statementSheetName}"`);

  const receiptSheet = ss.getSheetByName(receiptSheetName);
  if (!receiptSheet) throw new Error(`ไม่พบ Sheet "${receiptSheetName}"`);

  toast(`⏳ Match Statement ↔ ${receiptSheetName}...`, 'FinFin');

  // ─── Detect SCB format ────────────────────────────────────────────────────
  const fmt = detectStatementFormat_(stmtSheet);
  Logger.log(`SCB format detected: ${fmt.name} (header row ${fmt.headerRow})`);

  // ─── Load data ────────────────────────────────────────────────────────────
  const allStmt = stmtSheet.getDataRange().getValues();
  const stmtData = allStmt.slice(fmt.headerRow);

  const receiptData = getReceiptData_(receiptSheet);

  // ─── Build INV lookup from Receipt sheet ──────────────────────────────────
  const recMap = {};
  for (let i = 0; i < receiptData.length; i++) {
    const inv = normalizeInv_(String(receiptData[i][CONFIG.RECEIPT_COL.INV] || '').trim());
    if (!inv) continue;
    if (!recMap[inv]) recMap[inv] = [];
    recMap[inv].push({ idx: i, row: receiptData[i] });
  }

  // ─── Process Statement rows ───────────────────────────────────────────────
  const report = [[
    'วันที่ (Bank)', 'ยอดรับ (฿)', 'Note', 'INV Code',
    'สถานะ', 'Receipt Row', 'ยอดใน Receipt', 'วันที่รับใน Receipt',
    'ผลต่างยอด', 'หมายเหตุ',
  ]];

  let cntMatch = 0, cntWarn = 0, cntFail = 0, cntNoInv = 0;

  for (const stRow of stmtData) {
    const deposit = parseAmount(stRow[fmt.col.DEPOSIT]);
    if (deposit <= 0) continue;

    const bankDate = formatDateForAPI(stRow[fmt.col.DATE]);
    const note     = String(stRow[fmt.col.NOTE] || '').trim();
    const bankDesc = String(stRow[fmt.col.DESC] || '').trim();

    let invCode = extractInv_(note);
    if (!invCode && fmt.col.INV !== undefined) {
      const rawInv = normalizeInv_(String(stRow[fmt.col.INV] || '').trim());
      if (rawInv) invCode = rawInv;
    }

    if (!invCode) {
      report.push([bankDate, deposit, note, '', 'ยังไม่กรอก INV', '', '', '', '', bankDesc]);
      cntNoInv++;
      continue;
    }

    const matches = recMap[invCode];
    if (!matches || matches.length === 0) {
      report.push([bankDate, deposit, note, invCode, 'ไม่พบใน Receipt', '', '', '', '',
                   `INV "${invCode}" ไม่มีใน ${receiptSheetName}`]);
      cntFail++;
      continue;
    }

    let best = null, bestScore = -1;
    for (const m of matches) {
      const recAmt  = parseAmount(m.row[CONFIG.RECEIPT_COL.AMT]);
      const recDate = formatDateForAPI(m.row[CONFIG.RECEIPT_COL.PAY_DATE]);
      let score = 0;
      if (Math.abs(recAmt - deposit) < 1)        score += 2;
      else if (Math.abs(recAmt - deposit) < 100) score += 1;
      if (recDate === bankDate)                  score += 2;
      if (score > bestScore) { bestScore = score; best = { m, recAmt, recDate }; }
    }

    const { m, recAmt, recDate } = best;
    const diff = deposit - recAmt;
    let status, remark;

    if (Math.abs(diff) < 1 && recDate === bankDate) {
      status = '✅ ตรงกัน';  remark = '';  cntMatch++;
    } else if (Math.abs(diff) < 1) {
      status = '⚠️ ยอดตรง วันต่าง';
      remark = `Bank ${bankDate} / Receipt ${recDate}`;
      cntWarn++;
    } else if (recDate === bankDate) {
      status = '⚠️ วันตรง ยอดต่าง';
      remark = `ต่าง ${diff.toLocaleString()} บาท`;
      cntWarn++;
    } else {
      status = '❌ ยอดและวันต่าง';
      remark = `Bank ${bankDate} ${deposit.toLocaleString()} vs Receipt ${recDate} ${recAmt.toLocaleString()}`;
      cntFail++;
    }

    report.push([bankDate, deposit, note, invCode, status,
                 m.idx + CONFIG.RECEIPT_HEADER_ROW + 1, recAmt, recDate, diff, remark]);
  }

  // ─── Write report ─────────────────────────────────────────────────────────
  let rpt = ss.getSheetByName(CONFIG.STATEMENT_REPORT_NAME);
  if (rpt) { rpt.clearContents(); rpt.clearFormats(); }
  else     { rpt = ss.insertSheet(CONFIG.STATEMENT_REPORT_NAME); }

  rpt.getRange(1, 1, report.length, report[0].length).setValues(report);
  rpt.getRange(1, 1, 1, report[0].length)
    .setBackground('#4472C4').setFontColor('#FFFFFF').setFontWeight('bold');
  rpt.setFrozenRows(1);

  const bgMap = {
    '✅': '#E2EFDA',
    '⚠️': '#FFF2CC',
    '❌': '#FFE0E0',
    'ไม่พบ': '#FFE0E0',
    'ยังไม่': '#F2F2F2',
  };
  for (let i = 1; i < report.length; i++) {
    const st = String(report[i][4]);
    const bg = Object.entries(bgMap).find(([k]) => st.startsWith(k))?.[1] || '#FFFFFF';
    rpt.getRange(i + 1, 1, 1, report[i].length).setBackground(bg);
  }

  rpt.appendRow([
    `สรุป: ✅ ${cntMatch}  ⚠️ ${cntWarn}  ❌ ${cntFail}  ยังไม่กรอก INV: ${cntNoInv}  [format: ${fmt.name}]`,
    '', '', '', '', '', '', '', '', '',
  ]);
  rpt.getRange(rpt.getLastRow(), 1).setFontWeight('bold').setBackground('#D9D9D9');

  rpt.autoResizeColumns(1, report[0].length);
  ss.setActiveSheet(rpt);

  const summary = `Match เสร็จ — ✅ ${cntMatch}, ⚠️ ${cntWarn}, ❌ ${cntFail}, ยังไม่กรอก INV: ${cntNoInv} (SCB fmt: ${fmt.name})`;
  toast(summary, 'FinFin', 10);
  Logger.log(summary);
  return summary;
}

// ─── Format Auto-Detect ───────────────────────────────────────────────────────

/**
 * Detect SCB format โดยตรวจ content
 * @returns {{ name, headerRow, col }}
 */
function detectStatementFormat_(sheet) {
  const lastRow = Math.min(sheet.getLastRow(), 10);
  const lastCol = Math.min(sheet.getLastColumn(), 20);
  if (lastRow === 0 || lastCol === 0) {
    return fallbackFormat_();
  }
  const sample = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const firstRowText = sample[0].map(v => String(v || '').toLowerCase()).join('|');

  // RAW: "Account Number" / "Account Name" ในแถวแรก
  if (firstRowText.includes('account number') || firstRowText.includes('account name')) {
    return {
      name: 'RAW',
      headerRow: CONFIG.STATEMENT_FORMAT_RAW.HEADER_ROW,
      col: CONFIG.STATEMENT_FORMAT_RAW.COL,
    };
  }

  // ENHANCED: header มี "ยอดเงินเข้าบัญชี" หรือ "รายละเอียดรับชำระ"
  for (const row of sample) {
    const joined = row.map(v => String(v || '')).join('|');
    if (joined.includes('ยอดเงินเข้าบัญชี') || joined.includes('รายละเอียดรับชำระ')) {
      return {
        name: 'ENHANCED',
        headerRow: CONFIG.STATEMENT_FORMAT_ENHANCED.HEADER_ROW,
        col: CONFIG.STATEMENT_FORMAT_ENHANCED.COL,
      };
    }
  }

  return fallbackFormat_();
}

function fallbackFormat_() {
  Logger.log('SCB format not detected — fallback to ENHANCED');
  return {
    name: 'ENHANCED-fallback',
    headerRow: CONFIG.STATEMENT_FORMAT_ENHANCED.HEADER_ROW,
    col: CONFIG.STATEMENT_FORMAT_ENHANCED.COL,
  };
}

// ─── Receipt Helpers ──────────────────────────────────────────────────────────

function getReceiptData_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= CONFIG.RECEIPT_HEADER_ROW) return [];
  return sheet
    .getRange(CONFIG.RECEIPT_HEADER_ROW + 1, 1, lastRow - CONFIG.RECEIPT_HEADER_ROW, sheet.getLastColumn())
    .getValues();
}

function getCurrentReceiptSheetName() {
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  try {
    return findSheetRobust(ss, CONFIG.RECEIPT_SHEET_PREFIX, getCurrentMonthSheetName()).getName();
  } catch (_) {
    return findLatestSheetByPrefix(ss, CONFIG.RECEIPT_SHEET_PREFIX).getName();
  }
}

function getCurrentSumSheetName() {
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  try {
    return findSheetRobust(ss, CONFIG.SUM_SHEET_PREFIX, getCurrentMonthSheetName()).getName();
  } catch (_) {
    return findLatestSheetByPrefix(ss, CONFIG.SUM_SHEET_PREFIX).getName();
  }
}

// ─── INV Extraction ───────────────────────────────────────────────────────────

function extractInv_(note) {
  if (!note) return null;
  const m1 = note.match(/INV[-\s]?(\d{8,12})/i);
  if (m1) return m1[1];
  const m2 = note.match(/\b(\d{10})\b/);
  if (m2) return m2[1];
  return null;
}

function normalizeInv_(code) {
  return String(code).replace(/^INV[-\s]?/i, '').trim();
}
