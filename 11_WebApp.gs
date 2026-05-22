/**
 * FinFin — Web App Router
 *
 * Deploy: Extensions → Apps Script → Deploy → New deployment → Web app
 *   - Execute as: Me
 *   - Who has access: Anyone
 *   - Copy the /exec URL → ใส่ใน Python client
 *
 * หลัง deploy: รัน setupWebAppApiKey('<your-secret>') ครั้งเดียวเพื่อตั้ง API key
 */

const WEBAPP_API_KEY_PROP = 'FINFIN_API_KEY';
const WEBAPP_OVERRIDE_KEYS = [
  'CONNECT_ID', 'USER_TOKEN', 'SPREADSHEET_ID', 'RETURN_SPREADSHEET_ID',
];

// ─── Entry Points ─────────────────────────────────────────────────────────────

function doGet(e) {
  return jsonResponse_({ ok: true, message: 'FinFin GAS Web App alive', now: new Date().toISOString() });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData?.contents || '{}');
    const { action, apiKey, params } = body;

    if (!verifyApiKey_(apiKey)) {
      return jsonResponse_({ ok: false, error: 'Invalid API key' });
    }

    loadConfigOverrides_();
    const data = routeAction_(action, params || {});
    return jsonResponse_({ ok: true, data });
  } catch (e) {
    // stack เก็บไว้ฝั่ง server เท่านั้น — ไม่ส่งออกไปให้ client (เลี่ยง info leak)
    Logger.log(`doPost error: ${(e && e.stack) || (e && e.message) || e}`);
    return jsonResponse_({ ok: false, error: String((e && e.message) || e) });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function verifyApiKey_(key) {
  const stored = PropertiesService.getScriptProperties().getProperty(WEBAPP_API_KEY_PROP);
  return !!stored && stored === key;
}

function loadConfigOverrides_() {
  const props = PropertiesService.getScriptProperties();
  for (const k of WEBAPP_OVERRIDE_KEYS) {
    const v = props.getProperty(`FINFIN_${k}`);
    if (v) CONFIG[k] = v;
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

function routeAction_(action, p) {
  switch (action) {
    case 'ping':              return { pong: new Date().toISOString() };
    case 'config/get':        return getConfigMasked_();
    case 'config/set':        return setConfigProps_(p);
    case 'part1/run':         return runPart1_TaxInvoice(resolveSheet_(p.sheetName, CONFIG.RECEIPT_SHEET_PREFIX));
    case 'part1/servicefee':  return runPart1_ServiceFee(resolveSheet_(p.sheetName, CONFIG.SUM_SHEET_PREFIX));
    case 'part2/run':         return runPart2_Invoice(resolveSheet_(p.sheetName, CONFIG.SUM_SHEET_PREFIX));
    case 'part3/run':         return runPart3_LateFee(resolveSheet_(p.sheetName, CONFIG.STATEMENT_SHEET_PREFIX));
    case 'part4/run':         return runPart4_CreditNote();
    case 'part5/run': {
      const stmt = resolveSheet_(p.statementSheetName || p.sheetName, CONFIG.STATEMENT_SHEET_PREFIX);
      const rec  = resolveSheet_(p.receiptSheetName   || p.sheetName, CONFIG.RECEIPT_SHEET_PREFIX);
      return runPart5_StatementMatch(stmt, rec);
    }
    case 'poll/now':          return pollAllQueues();
    case 'poll/status':       return getQueueStatusJson_();
    case 'dashboard/refresh': return refreshDashboard(p.month);
    case 'logs/tail':         return getLogsTail_(p.limit || 50);
    case 'notifications/list': return getNotifications_();
    case 'test/peak':         return testPeakConnection_();
    default:                  throw new Error(`Unknown action: ${action}`);
  }
}

/**
 * ถ้า name ว่าง → return null (GAS จะ default เป็นเดือนปัจจุบัน)
 * ถ้า name เป็น "MM.YYYY" → เติม prefix อัตโนมัติ
 * ถ้า name มี prefix อยู่แล้ว → คืนตามเดิม
 */
function resolveSheet_(name, prefix) {
  if (!name || !String(name).trim()) return null;
  const s = String(name).trim();
  if (s.startsWith(prefix)) return s;
  return `${prefix}${s}`;
}

// ─── Config (masked read / write) ─────────────────────────────────────────────

function getConfigMasked_() {
  const mask = v => v && v !== 'YOUR_CONNECT_ID' && v !== 'YOUR_USER_TOKEN' && v !== 'YOUR_SPREADSHEET_ID'
    ? v.substring(0, 4) + '****' + v.substring(v.length - 4)
    : '(not set)';
  return {
    CONNECT_ID:            mask(CONFIG.CONNECT_ID),
    USER_TOKEN:            mask(CONFIG.USER_TOKEN),
    SPREADSHEET_ID:        CONFIG.SPREADSHEET_ID,
    RETURN_SPREADSHEET_ID: CONFIG.RETURN_SPREADSHEET_ID,
  };
}

function setConfigProps_(p) {
  const props = PropertiesService.getScriptProperties();
  const updated = [];
  for (const k of WEBAPP_OVERRIDE_KEYS) {
    if (p[k] && String(p[k]).trim()) {
      props.setProperty(`FINFIN_${k}`, String(p[k]).trim());
      CONFIG[k] = String(p[k]).trim();
      updated.push(k);
    }
  }
  return { updated };
}

// ─── Status & Logs ────────────────────────────────────────────────────────────

function getQueueStatusJson_() {
  const out = {};
  for (const t of ['receipt', 'invoice', 'receipt_fee']) {
    out[t] = getQueueEntries(t).length;
  }
  return out;
}

function getLogsTail_(limit) {
  limit = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
  const log = getLogSheet();
  const lastRow = log.getLastRow();
  if (lastRow <= 1) return [];
  const start = Math.max(2, lastRow - limit + 1);
  const n = lastRow - start + 1;
  return log.getRange(start, 1, n, 8).getValues()
    .map(([ts, part, sheet, row, inv, status, doc, msg]) => ({
      ts: ts instanceof Date ? ts.toISOString() : String(ts),
      part, sheet, row, inv, status, doc, msg,
    }));
}

/**
 * รวบรวมการแจ้งเตือนทั้งหมดสำหรับหน้า "แจ้งเตือน" ใน client
 * จัด 4 หมวด: errors (ต้องแก้) / actions (ต้องลงมือ) /
 *             pending (ระบบทำต่อเอง) / lastRun (สรุปกิจกรรมล่าสุด)
 */
function getNotifications_() {
  const log     = getLogSheet();
  const lastRow = log.getLastRow();
  const SCAN    = 400;

  let rows = [];
  if (lastRow > 1) {
    const start = Math.max(2, lastRow - SCAN + 1);
    rows = log.getRange(start, 1, lastRow - start + 1, 8).getValues()
      .map(([ts, part, sheet, row, inv, status, doc, msg]) => ({
        ts:     ts instanceof Date ? ts.toISOString() : String(ts),
        part:   String(part   || ''),
        sheet:  String(sheet  || ''),
        row:    row,
        inv:    String(inv    || ''),
        status: String(status || ''),
        doc:    String(doc    || ''),
        msg:    String(msg    || ''),
      }));
  }

  // ─── errors — log status ERROR (ใหม่สุดก่อน) ───────────────────────────────
  const errors = rows
    .filter(r => r.status === 'ERROR')
    .slice(-50)
    .reverse()
    .map(r => ({ ts: r.ts, part: r.part, sheet: r.sheet, row: r.row, inv: r.inv, msg: r.msg }));

  // ─── actions — งานที่ผู้ใช้ต้องลงมือ ────────────────────────────────────────
  const actions = [];

  // (1) แถวที่ติด [IN-PEAK] — ต้องหาเลขเอกสารใน PEAK เอง (เก็บล่าสุดต่อ sheet+row)
  const inPeak = {};
  rows.forEach(r => {
    if (r.doc === CONFIG.DUPLICATE_MARKER) inPeak[`${r.sheet}|${r.row}`] = r;
  });
  Object.keys(inPeak).sort().forEach(k => {
    const r = inPeak[k];
    actions.push({
      kind:   'inpeak',
      label:  `หาเลขเอกสารใน PEAK — ${r.sheet} แถว ${r.row}`,
      detail: `สัญญา ${r.inv} มีเอกสารใน PEAK แล้วแต่ระบบหาเลขที่ไม่ได้ — `
            + `เปิด PEAK ค้นด้วยเลขสัญญา แล้วกรอกเลขที่เอกสารลง Col PEAK_DOC ด้วยตนเอง`,
    });
  });

  // (2) queue ที่ยังไม่ได้ poll
  const qInv = getQueueEntries('invoice').length;
  const qRec = getQueueEntries('receipt').length;
  const qFee = getQueueEntries('receipt_fee').length;
  const qTotal = qInv + qRec + qFee;
  if (qTotal > 0) {
    actions.push({
      kind:   'queue',
      label:  `Poll Queue — มี ${qTotal} รายการรอผล`,
      detail: `Invoice ${qInv} · Receipt ${qRec} · Late Fee ${qFee} — `
            + `กด "Poll Queue ทันที" ในหน้า Tasks เพื่อดึงเลขเอกสารกลับมาเขียนลงชีต`,
    });
  }

  // (3) contact ยังไม่ sync (SKIP เพราะไม่พบ contactId)
  const noContact = {};
  rows.forEach(r => {
    if (r.status === 'SKIP' && r.msg.indexOf('contactId') >= 0) {
      noContact[`${r.sheet}|${r.row}`] = r;
    }
  });
  const ncCount = Object.keys(noContact).length;
  if (ncCount > 0) {
    actions.push({
      kind:   'contact',
      label:  `Contact ยังไม่ครบ — ${ncCount} แถวถูกข้าม`,
      detail: `บางสัญญายังไม่มี contact ใน PEAK — รัน Sync Contacts แล้วรัน task เดิมอีกครั้ง`,
    });
  }

  // ─── pending — ระบบทำต่อให้เองอัตโนมัติ ────────────────────────────────────
  const pending = [];
  const props = PropertiesService.getScriptProperties().getProperties();
  Object.keys(props).filter(k => k.startsWith('CONTINUATION_')).forEach(k => {
    let ctx = {};
    try { ctx = JSON.parse(props[k]); } catch (e) {}
    pending.push({
      kind:   'continuation',
      label:  `ระบบจะทำต่ออัตโนมัติ — ${ctx.functionName || k.replace('CONTINUATION_', '')}`,
      detail: `${ctx.sheetName ? 'ชีต ' + ctx.sheetName + ' · ' : ''}`
            + `ครั้งที่ ${ctx.attempt || '?'} — ไม่ต้องทำอะไร ระบบตั้งเวลาทำงานต่อไว้แล้ว`,
    });
  });
  rows.filter(r => r.status === 'WARN' && r.msg.indexOf('quota') >= 0)
      .slice(-10).reverse()
      .forEach(r => pending.push({
        kind:   'quota',
        label:  `หยุดชั่วคราว (โควตา PEAK) — ${r.part}`,
        detail: `${r.ts}  ·  ${r.msg}`,
      }));

  // ─── lastRun — สรุปกิจกรรมล่าสุดต่อ Part ───────────────────────────────────
  const byPart = {};
  rows.forEach(r => {
    if (!r.part) return;
    const p = byPart[r.part]
      || (byPart[r.part] = { part: r.part, success: 0, error: 0, skip: 0, queued: 0, lastTs: '' });
    if      (r.status === 'SUCCESS') p.success++;
    else if (r.status === 'ERROR')   p.error++;
    else if (r.status === 'SKIP')    p.skip++;
    else if (r.status === 'QUEUED')  p.queued++;
    if (r.ts > p.lastTs) p.lastTs = r.ts;
  });
  const lastRun = Object.keys(byPart).sort().map(k => byPart[k]);

  return {
    errors, actions, pending, lastRun,
    badge:       errors.length + actions.length,
    generatedAt: new Date().toISOString(),
  };
}

function testPeakConnection_() {
  if (CONFIG.CONNECT_ID === 'YOUR_CONNECT_ID') throw new Error('CONNECT_ID not set');
  if (CONFIG.USER_TOKEN === 'YOUR_USER_TOKEN') throw new Error('USER_TOKEN not set');
  resetClientTokenCache();
  const token = getClientToken();
  return `✅ PEAK connected. Token: ${token.substring(0, 20)}...`;
}

// ─── Setup Helper (รันครั้งเดียวจาก GAS editor) ───────────────────────────────

/**
 * ตั้ง shared API key สำหรับ Web App
 * ใช้งาน: เปิด Apps Script editor → ใส่ค่า apiKey → กด Run
 */
function setupWebAppApiKey(apiKey) {
  if (!apiKey) throw new Error('กรุณาใส่ apiKey');
  PropertiesService.getScriptProperties().setProperty(WEBAPP_API_KEY_PROP, apiKey);
  Logger.log(`✅ API Key saved`);
  return '✅ API Key saved — redeploy web app if already deployed';
}

function showWebAppApiKey() {
  const k = PropertiesService.getScriptProperties().getProperty(WEBAPP_API_KEY_PROP);
  Logger.log(k ? `API Key = "${k}"` : '(not set)');
  return k || '(not set)';
}
