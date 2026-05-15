/**
 * FinFin Automation — Contact Sync
 *
 * PEAK requires a contact to exist before creating receipts/invoices with contactCode.
 * We use invCode (contract number) as the contact code — unique per customer.
 *
 * type 5 = บุคคลธรรมดา (individual) — MPTECH customers are individuals.
 *
 * Performance strategy:
 *   - Cache confirmed contacts in ScriptProperties (survives between runs)
 *   - Write cache every 20 new contacts (survives mid-loop timeout)
 *   - POST-first, no GET check (halves API calls)
 *   - Time guard: stop sync at 4.5 min, let Part 1 continue for synced contacts
 *     → unsynced contacts → receipt fails → PEAK_DOC cleared → retried next run
 */

const CONTACT_CACHE_KEY_    = 'PEAK_SYNCED_CONTACTS';
const CONTACT_SYNC_SAVE_N_  = 20;               // write cache every N new contacts
const CONTACT_SYNC_MAX_MS_  = 4.5 * 60 * 1000; // 4.5 min soft limit per call

// ─── Batch Sync (called by Part 1 / Part 2 / Part 3) ─────────────────────────

/**
 * Sync contacts สำหรับ invCode หลายรายการพร้อมกัน
 *   - POST สร้าง contact โดยตรง (ไม่ GET ก่อน — เร็วขึ้น 2x)
 *   - resCode 400 = duplicate → contact มีอยู่แล้ว → cache ได้เลย
 *   - บันทึก cache ทุก CONTACT_SYNC_SAVE_N_ รายการ → ข้อมูลไม่หายถ้า timeout
 *   - หยุดเมื่อ elapsed > CONTACT_SYNC_MAX_MS_ — ไม่ throw, ปล่อย Part 1 ทำงานต่อ
 * @param {{ [invCode]: name }} codeNameMap
 */
function ensureContactsBatch_(codeNameMap) {
  const props  = PropertiesService.getScriptProperties();
  const raw    = props.getProperty(CONTACT_CACHE_KEY_);
  const cache  = raw ? JSON.parse(raw) : {};
  const start  = Date.now();
  let newCount = 0;

  for (const [invCode, name] of Object.entries(codeNameMap)) {
    const code = String(invCode).trim();
    if (!code || cache[code]) continue;  // cached → skip API call

    // Time guard: stop if near 4.5 min (GAS hard limit = 6 min)
    if (Date.now() - start > CONTACT_SYNC_MAX_MS_) {
      Logger.log(`Contact sync: time limit — cached ${newCount} this run, re-run to continue`);
      break;
    }

    const displayName = (String(name || '').trim() || `สัญญา ${code}`).slice(0, 255);

    try {
      callPeakAPI('post', '/contacts/', {
        PeakContacts: { contacts: [{ code, name: displayName, type: 5 }] },
      });
      cache[code] = 1;
    } catch (e) {
      const msg = String(e.message);
      if (msg.includes('400') || /duplic|exist|already/i.test(msg)) {
        cache[code] = 1;  // duplicate = already exists
      } else {
        Logger.log(`Contact error [${code}]: ${msg}`);
        continue;  // don't cache failed contacts
      }
    }

    newCount++;
    // Save every N to survive mid-loop timeout
    if (newCount % CONTACT_SYNC_SAVE_N_ === 0) {
      props.setProperty(CONTACT_CACHE_KEY_, JSON.stringify(cache));
    }
  }

  if (newCount > 0) {
    props.setProperty(CONTACT_CACHE_KEY_, JSON.stringify(cache));
  }
}

// ─── Single-contact wrapper ───────────────────────────────────────────────────

function ensureContact_(invCode, name) {
  ensureContactsBatch_({ [String(invCode).trim()]: name });
}

// ─── Standalone Sync ─────────────────────────────────────────────────────────

/**
 * Sync contacts ทั้งหมดจาก Receipt sheet
 * รันซ้ำได้หลายรอบ — contacts ที่ sync แล้วข้ามเลย (cache)
 * ถ้า timeout → รันซ้ำ → ดูผลใน Execution Log
 * @param {string} [sheetName]
 */
function runSyncContacts(sheetName) {
  sheetName = sheetName || getCurrentReceiptSheetName();
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error(`ไม่พบ Sheet "${sheetName}"`);

  const data = getReceiptData_(sheet);
  const codeNameMap = {};
  for (const row of data) {
    const code = String(row[CONFIG.RECEIPT_COL.INV] || '').trim();
    if (code && !codeNameMap[code]) {
      codeNameMap[code] = String(row[CONFIG.RECEIPT_COL.NAME] || '').trim();
    }
  }

  const total = Object.keys(codeNameMap).length;
  toast(`⏳ Syncing ${total} contacts...`, 'FinFin');
  ensureContactsBatch_(codeNameMap);

  const cache = JSON.parse(
    PropertiesService.getScriptProperties().getProperty(CONTACT_CACHE_KEY_) || '{}'
  );
  const done = Object.keys(codeNameMap).filter(c => cache[c]).length;
  const left = total - done;

  const summary = left > 0
    ? `Sync Contacts: ${done}/${total} — เหลือ ${left} รายการ กรุณารันซ้ำ`
    : `Sync Contacts เสร็จ ✅ (${done} รายการ)`;
  toast(summary, 'FinFin', 10);
  Logger.log(summary);
  return summary;
}

// ─── Cleanup Helpers ─────────────────────────────────────────────────────────

/**
 * ล้าง PEAK_DOC ที่เป็น JSON blob หรือ PROCESSING ค้าง
 * รันก่อน Part 1 ถ้าเคยรันแล้วได้ JSON blob ใน column PEAK_DOC
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
 * รีเซ็ต contact sync cache (รันเมื่อ PEAK reset หรือสลับ environment)
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
