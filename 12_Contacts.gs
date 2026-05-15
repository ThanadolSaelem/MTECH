/**
 * FinFin Automation — Contact Sync
 *
 * PEAK requires a contact to exist before creating receipts/invoices with contactCode.
 * We use invCode (contract number) as the contact code — unique per customer.
 *
 * type 5 = บุคคลธรรมดา (individual) — MPTECH customers are individuals.
 */

/**
 * ตรวจว่า contact ใน PEAK มีอยู่แล้ว — ถ้าไม่มี สร้างใหม่
 * @param {string} invCode  รหัสสัญญา (→ contactCode ใน PEAK)
 * @param {string} name     ชื่อลูกค้า (required field)
 */
function ensureContact_(invCode, name) {
  const code = String(invCode).trim();
  if (!code) return;
  const displayName = (String(name || '').trim() || `สัญญา ${code}`).slice(0, 255);

  // ตรวจก่อนว่ามีอยู่แล้ว
  try {
    const res = callPeakAPI('get', '/contacts', null, { code });
    const inner = res && res.PeakContacts;
    if (inner) {
      const c = inner.contacts;
      const found = Array.isArray(c) ? c.length > 0 : (c && (c.id || c.code));
      if (found) return;
    }
  } catch (_) {
    // GET ล้มเหลว (404 / error) → ลอง POST ต่อ
  }

  // สร้าง contact ใหม่
  try {
    callPeakAPI('post', '/contacts/', {
      PeakContacts: {
        contacts: [{ code, name: displayName, type: 5 }],
      },
    });
  } catch (e) {
    // resCode 400 มักหมายถึง duplicate code → contact มีอยู่แล้ว → OK
    const msg = String(e.message);
    if (msg.includes('400') || /duplic|exist|already/i.test(msg)) return;
    throw e;
  }
}

/**
 * Sync contacts ทั้งหมดจาก Receipt sheet ไปยัง PEAK
 * รันก่อน Part 1 ถ้ายังไม่เคย sync
 * @param {string} [sheetName]
 */
function runSyncContacts(sheetName) {
  sheetName = sheetName || getCurrentReceiptSheetName();
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error(`ไม่พบ Sheet "${sheetName}"`);

  toast(`⏳ Sync Contacts — ${sheetName}`, 'FinFin');
  const data = getReceiptData_(sheet);

  const seen = {};
  let ok = 0, skip = 0, err = 0;

  for (const row of data) {
    const invCode = String(row[CONFIG.RECEIPT_COL.INV] || '').trim();
    if (!invCode) continue;
    if (seen[invCode]) { skip++; continue; }
    seen[invCode] = true;

    const name = String(row[CONFIG.RECEIPT_COL.NAME] || '').trim();
    try {
      ensureContact_(invCode, name);
      ok++;
    } catch (e) {
      Logger.log(`Contact error [${invCode}]: ${e.message}`);
      err++;
    }
  }

  const summary = `Sync Contacts — ✅ ${ok}, Skip (ซ้ำ): ${skip}, Error: ${err}`;
  toast(summary, 'FinFin', 10);
  Logger.log(summary);
  return summary;
}

/**
 * ดึง contact จาก PEAK และ log — ใช้ test ว่า invCode ถูก sync แล้ว
 */
function testGetContact() {
  const invCode = '1752485138';  // แก้เป็น invCode จริงก่อนรัน
  const res = callPeakAPI('get', '/contacts', null, { code: invCode });
  Logger.log(JSON.stringify(res, null, 2));
}
