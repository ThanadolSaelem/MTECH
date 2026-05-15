/**
 * FinFin Automation — Contact Sync
 *
 * PEAK requires a contact to exist before creating receipts/invoices with contactCode.
 * We use invCode (contract number) as the contact code — unique per customer.
 *
 * type 5 = บุคคลธรรมดา (individual) — MPTECH customers are individuals.
 *
 * Performance: confirmed contacts are cached in ScriptProperties.
 * First run: GET+POST each new contact (~1s each). Subsequent runs: skip API call entirely.
 */

const CONTACT_CACHE_KEY_ = 'PEAK_SYNCED_CONTACTS';

// ─── Batch Sync (used by Part 1, Part 2, Part 3) ─────────────────────────────

/**
 * Sync contacts สำหรับ invCode หลายรายการพร้อมกัน
 * อ่าน/เขียน ScriptProperties แค่ครั้งเดียว — เร็วกว่า loop ensureContact_
 * @param {{ [invCode]: name }} codeNameMap
 */
function ensureContactsBatch_(codeNameMap) {
  const props = PropertiesService.getScriptProperties();
  const raw   = props.getProperty(CONTACT_CACHE_KEY_);
  const cache = raw ? JSON.parse(raw) : {};

  let changed = false;

  for (const [invCode, name] of Object.entries(codeNameMap)) {
    const code = String(invCode).trim();
    if (!code || cache[code]) continue;  // already confirmed → skip API

    const displayName = (String(name || '').trim() || `สัญญา ${code}`).slice(0, 255);
    let confirmed = false;

    // ลอง GET ก่อน
    try {
      const res = callPeakAPI('get', '/contacts', null, { code });
      const inner = res && res.PeakContacts;
      if (inner) {
        const c = inner.contacts;
        confirmed = Array.isArray(c) ? c.length > 0 : !!(c && (c.id || c.code));
      }
    } catch (_) {}

    if (!confirmed) {
      // POST สร้างใหม่
      try {
        callPeakAPI('post', '/contacts/', {
          PeakContacts: { contacts: [{ code, name: displayName, type: 5 }] },
        });
        confirmed = true;
      } catch (e) {
        const msg = String(e.message);
        // resCode 400 = duplicate → contact มีอยู่แล้ว
        if (msg.includes('400') || /duplic|exist|already/i.test(msg)) {
          confirmed = true;
        } else {
          Logger.log(`Contact error [${code}]: ${msg}`);
        }
      }
    }

    if (confirmed) {
      cache[code] = 1;
      changed = true;
    }
  }

  if (changed) {
    props.setProperty(CONTACT_CACHE_KEY_, JSON.stringify(cache));
  }
}

// ─── Single-contact wrapper (backward compat) ────────────────────────────────

function ensureContact_(invCode, name) {
  ensureContactsBatch_({ [String(invCode).trim()]: name });
}

// ─── Standalone sync (รันแยกก่อน Part 1 ถ้าต้องการ) ─────────────────────────

/**
 * Sync contacts ทั้งหมดจาก Receipt sheet ไปยัง PEAK
 * รัน re-run ได้หลายรอบ — contacts ที่ sync แล้วจะข้ามทันที (< 0.1s)
 * @param {string} [sheetName]
 */
function runSyncContacts(sheetName) {
  sheetName = sheetName || getCurrentReceiptSheetName();
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error(`ไม่พบ Sheet "${sheetName}"`);

  toast(`⏳ Sync Contacts — ${sheetName}`, 'FinFin');
  const data = getReceiptData_(sheet);

  const codeNameMap = {};
  for (const row of data) {
    const code = String(row[CONFIG.RECEIPT_COL.INV] || '').trim();
    if (code && !codeNameMap[code]) {
      codeNameMap[code] = String(row[CONFIG.RECEIPT_COL.NAME] || '').trim();
    }
  }

  const total = Object.keys(codeNameMap).length;
  toast(`⏳ Syncing ${total} unique contacts...`, 'FinFin');
  ensureContactsBatch_(codeNameMap);

  const summary = `Sync Contacts เสร็จ — ${total} รายการ`;
  toast(summary, 'FinFin', 10);
  Logger.log(summary);
  return summary;
}

// ─── Cleanup Helpers ─────────────────────────────────────────────────────────

/**
 * ล้างค่า PEAK_DOC ที่เป็น JSON blob (จาก bug เก่าที่เขียน raw response ลงไป)
 * รันก่อน Part 1 ถ้าเคยรันแล้วได้ JSON blob ใน column PEAK_DOC
 * @param {string} [sheetName]
 */
function clearBadPeakDocs(sheetName) {
  sheetName = sheetName || getCurrentReceiptSheetName();
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error(`ไม่พบ Sheet "${sheetName}"`);

  const data = getReceiptData_(sheet);
  let cleared = 0;

  for (let i = 0; i < data.length; i++) {
    const val = String(data[i][CONFIG.RECEIPT_COL.PEAK_DOC] || '').trim();
    // JSON blob (starts with "{") หรือ stuck PROCESSING_MARKER
    if (val.startsWith('{') || val === CONFIG.PROCESSING_MARKER) {
      writeReceiptCell_(sheet, i, CONFIG.RECEIPT_COL.PEAK_DOC, '');
      cleared++;
    }
  }

  const msg = `Cleared ${cleared} bad PEAK_DOC values from "${sheetName}"`;
  toast(msg, 'FinFin', 10);
  Logger.log(msg);
  return msg;
}

/**
 * รีเซ็ต contact sync cache (รันเมื่อ UAT reset หรือ PEAK สลับ environment)
 */
function clearContactSyncCache() {
  PropertiesService.getScriptProperties().deleteProperty(CONTACT_CACHE_KEY_);
  Logger.log('Contact sync cache cleared.');
}

// ─── Debug ────────────────────────────────────────────────────────────────────

function testGetContact() {
  const invCode = '1752485138';  // แก้เป็น invCode จริงก่อนรัน
  const res = callPeakAPI('get', '/contacts', null, { code: invCode });
  Logger.log(JSON.stringify(res, null, 2));
}
