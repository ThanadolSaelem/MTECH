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

// ─── Contact type detection ──────────────────────────────────────────────────
// PEAK contact type — verified ✅
//   3 = นิติบุคคล (บจก./หจก./บริษัท/ห้างหุ้นส่วน)
//   5 = บุคคลธรรมดา
const CONTACT_TYPE_JURISTIC_   = 3;
const CONTACT_TYPE_INDIVIDUAL_ = 5;

// คำนำหน้านิติบุคคล — ถ้าชื่อขึ้นด้วย/ลงท้ายด้วยคำเหล่านี้ → type 3
const JURISTIC_PATTERNS_ = [
  /^บริษัท\s/,
  /^บจก\.?\s*/,
  /^บจ\.?\s*/,
  /^หจก\.?\s*/,
  /^หสน\.?\s*/,
  /^ห้างหุ้นส่วน/,
  /^ห้าง\s/,
  /^ร้าน\s/,
  /^สำนักงาน/,
  /^โรงงาน/,
  /^โรงเรียน/,
  /^โรงพยาบาล/,
  /^มูลนิธิ/,
  /^สมาคม/,
  /^สหกรณ์/,
  /^กรม/,
  /^กระทรวง/,
  /จำกัด\s*(\(มหาชน\))?\s*$/,
];

function _isJuristic_(fullName) {
  const s = String(fullName || '').trim();
  return JURISTIC_PATTERNS_.some(re => re.test(s));
}

// ─── Thai name parsing ───────────────────────────────────────────────────────
// PEAK prefixNameType mapping — verified ✅ codes เรียงตาม dropdown
//   0 = ไม่มี, 1 = คุณ, 2 = นาย, 3 = นาง, 4 = นางสาว/น.ส., 5 = อื่น ๆ (custom)
const THAI_PREFIXES_ = [
  { re: /^น\.ส\.\s*/,     code: 4, label: 'น.ส.' },
  { re: /^นางสาว\s*/,     code: 4, label: 'นางสาว' },
  { re: /^นาง(?!สาว)\s*/, code: 3, label: 'นาง' },
  { re: /^นาย\s*/,        code: 2, label: 'นาย' },
  { re: /^คุณ\s*/,        code: 1, label: 'คุณ' },
];

// prefix ที่ไม่ใช่มาตรฐาน — ส่งเป็น prefixNameType=5 (อื่น ๆ) + prefixNameOther
// เช่น ว่าที่ ร.ต.หญิง, ด.ต., นพ., ทพ., พล.ต., ฯลฯ
const STANDARD_PREFIX_CODES_ = new Set([0, 1, 2, 3, 4]);

function _parseThaiName_(fullName) {
  const s = String(fullName || '').trim();
  for (const p of THAI_PREFIXES_) {
    if (p.re.test(s)) {
      const rest = s.replace(p.re, '').trim();
      const parts = rest.split(/\s+/);
      return {
        prefixNameType:  p.code,
        prefixLabel:     p.label,
        prefixNameOther: '',
        firstName:       parts[0] || '',
        lastName:        parts.slice(1).join(' ') || '',
      };
    }
  }
  // ตรวจว่ามี prefix ที่ไม่ standard นำหน้าไหม
  // pattern: คำแรก (หรือหลายคำ) ที่ไม่ใช่ชื่อจริง — ดูจากการมีจุด (.) หรือ "ว่าที่"
  const customPrefixRe = /^((?:ว่าที่\s+)?(?:[ก-๙]+\.(?:[ก-๙]+\.)*\s*)+)/;
  const cpMatch = s.match(customPrefixRe);
  if (cpMatch) {
    const customPrefix = cpMatch[1].trim();
    const rest = s.slice(cpMatch[0].length).trim();
    const parts = rest.split(/\s+/);
    return {
      prefixNameType:  5,  // อื่น ๆ
      prefixLabel:     'อื่น ๆ',
      prefixNameOther: customPrefix,
      firstName:       parts[0] || rest,
      lastName:        parts.slice(1).join(' ') || '',
    };
  }
  const parts = s.split(/\s+/);
  return {
    prefixNameType:  0,
    prefixLabel:     '',
    prefixNameOther: '',
    firstName:       parts[0] || s,
    lastName:        parts.slice(1).join(' ') || '',
  };
}

// ─── Batch Sync (called by Part 1 / Part 2 / Part 3) ─────────────────────────────

function ensureContactsBatch_(codeNameMap) {
  const props  = PropertiesService.getScriptProperties();
  const raw    = props.getProperty(CONTACT_CACHE_KEY_);
  const cache  = raw ? JSON.parse(raw) : {};
  const start  = Date.now();
  let newCount = 0;

  for (const [invCode, name] of Object.entries(codeNameMap)) {
    const code = String(invCode).trim();
    if (!code || cache[code]) continue;

    if (Date.now() - start > CONTACT_SYNC_MAX_MS_) {
      Logger.log(`Contact sync: time limit — cached ${newCount} this run, re-run to continue`);
      break;
    }

    const displayName = (String(name || '').trim() || `สัญญา ${code}`).slice(0, 255);

    // ─── Build contact payload ตามประเภท: นิติบุคคล (type 3) หรือ บุคคลธรรมดา (type 5) ──
    let contactPayload;
    if (_isJuristic_(displayName)) {
      // นิติบุคคล — ส่งชื่อตรงๆ ไม่ parse prefix/firstName/lastName
      contactPayload = {
        code,
        name: displayName,
        type: CONTACT_TYPE_JURISTIC_,
      };
    } else {
      // บุคคลธรรมดา — parse คำนำหน้า + ชื่อจริง + นามสกุล
      const parsed = _parseThaiName_(displayName);
      // ส่ง name แบบไม่มี prefix นำหน้า — PEAK split name ตาม space แรกเป็น firstName/lastName
      // ถ้ามี prefix อยู่ใน name PEAK จะเอา prefix ไปเป็น firstName ทำให้ ชื่อจริง = "นาย" (ผิด)
      // prefix อยู่ใน dropdown (prefixNameType) แทน
      const peakName = parsed.prefixNameType > 0
        ? `${parsed.firstName}${parsed.lastName ? ' ' + parsed.lastName : ''}`.trim()
        : displayName;
      contactPayload = {
        code,
        name:           peakName,
        type:           CONTACT_TYPE_INDIVIDUAL_,
        prefixNameType: parsed.prefixNameType,
        firstName:      parsed.firstName,
        lastName:       parsed.lastName,
        // กรณี "อื่น ๆ" — ส่ง custom prefix (ว่าที่ ร.ต.หญิง, นพ., ทพ., ฯลฯ)
        ...(parsed.prefixNameOther ? { prefixNameOther: parsed.prefixNameOther } : {}),
      };
    }

    let confirmed = false;
    let postRes;
    let contactUuid = null;
    try {
      postRes = callPeakAPI('post', '/contacts/', {
        PeakContacts: { contacts: [contactPayload] },
      });
      Logger.log(`Contact POST raw [${code}] type=${contactPayload.type}: ${JSON.stringify(postRes).slice(0, 300)}`);
    } catch (e) {
      const msg = String(e.message);
      if (/duplic|exist|already|มีอยู่/i.test(msg)) {
        confirmed = true;
      } else {
        Logger.log(`Contact POST error [${code}]: ${msg}`);
      }
    }

    if (!confirmed && postRes) {
      const inner = postRes.PeakContacts;
      const c = inner && (Array.isArray(inner.contacts) ? inner.contacts[0] : inner.contacts);
      const rc = String((c && c.resCode) || (inner && inner.resCode) || '');
      // รองรับ field id หลายชื่อ: id / contactId / Id
      const idVal = (c && (c.id || c.contactId || c.Id)) || null;
      if (rc === '200' || idVal) {
        confirmed = true;
        contactUuid = idVal;
      } else if (rc === '100') {
        confirmed = true;
      } else {
        const desc = (c && c.resDesc) || (inner && inner.resDesc) || JSON.stringify(postRes).slice(0, 200);
        Logger.log(`Contact NOT created [${code}] name="${displayName}": resCode=${rc} — ${desc}`);
      }
    }

    if (confirmed) {
      cache[code] = contactUuid || 1;
      newCount++;
      if (newCount % CONTACT_SYNC_SAVE_N_ === 0) {
        props.setProperty(CONTACT_CACHE_KEY_, JSON.stringify(cache));
      }
    }
  }

  if (newCount > 0) {
    props.setProperty(CONTACT_CACHE_KEY_, JSON.stringify(cache));
  }
}

function ensureContact_(invCode, name) {
  ensureContactsBatch_({ [String(invCode).trim()]: name });
}

function isContactSynced_(invCode) {
  const cache = JSON.parse(
    PropertiesService.getScriptProperties().getProperty(CONTACT_CACHE_KEY_) || '{}'
  );
  return !!cache[String(invCode).trim()];
}

function getContactId_(invCode) {
  const props = PropertiesService.getScriptProperties();
  const cache = JSON.parse(props.getProperty(CONTACT_CACHE_KEY_) || '{}');
  const code = String(invCode).trim();
  const cached = cache[code];

  if (typeof cached === 'string' && cached.length > 10) return cached;

  try {
    const res = callPeakAPI('get', '/contacts', null, { code });
    Logger.log(`Contact GET raw [${code}]: ${JSON.stringify(res).slice(0, 300)}`);
    const contacts = res && res.PeakContacts && res.PeakContacts.contacts;
    const c = Array.isArray(contacts) ? contacts[0] : contacts;
    const uuid = c && (c.id || c.contactId || c.Id);
    if (uuid) {
      cache[code] = uuid;
      props.setProperty(CONTACT_CACHE_KEY_, JSON.stringify(cache));
      return uuid;
    }
    Logger.log(`getContactId_: no id in response for [${code}]`);
  } catch (e) {
    Logger.log(`getContactId_ GET error [${code}]: ${e.message}`);
  }
  return null;
}

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

function clearContactSyncCache() {
  PropertiesService.getScriptProperties().deleteProperty(CONTACT_CACHE_KEY_);
  Logger.log('Contact sync cache cleared.');
}

// ─── Fix wrong-name contacts in PEAK ─────────────────────────────────────────
/**
 * แก้ชื่อ contact ใน PEAK ที่มี prefix ซ้ำ (เช่น "นายนายธัชกร" → "นายธัชกร")
 *
 * เนื่องจากโค้ดเก่าต่อ TITLE + NAME โดยไม่เช็คซ้ำ — contact ที่สร้างไปก่อน fix
 * จะมีชื่อ prefix ซ้ำใน PEAK ฟังก์ชันนี้:
 *   1. วิ่งผ่าน Sum sheet → คำนวณชื่อที่ถูกต้อง
 *   2. GET contact จาก PEAK
 *   3. PUT อัปเดตถ้าชื่อไม่ตรง
 *   4. ล้าง contact cache ตอนจบ (force refresh UUID จาก PEAK รอบหน้า)
 */
function runFixContactNames(sheetName) {
  preFlightChecks_();
  sheetName = sheetName || getCurrentSumSheetName();
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  const sheet = getSheetByNameSmart_(ss, sheetName);
  if (!sheet) throw new Error(`ไม่พบ Sheet "${sheetName}"`);

  toast(`⏳ แก้ชื่อ Contact — ${sheetName}`, 'FinFin');

  const data = getSumData_(sheet);
  let countOk = 0, countSkip = 0, countError = 0;
  const guard = makeTimeGuard_(5);
  let stoppedEarly = false;

  for (let i = 0; i < data.length; i++) {
    if (guard.expired()) { stoppedEarly = true; break; }
    const row = data[i];
    const invCode = String(row[CONFIG.COL.INV] || '').trim();
    if (!invCode) continue;

    const title   = String(row[CONFIG.COL.TITLE] || '').trim();
    const rawName = String(row[CONFIG.COL.NAME]  || '').trim();
    const correctName = (rawName.startsWith(title) ? rawName : (title + rawName)).trim();
    if (!correctName) { countSkip++; continue; }

    try {
      const getRes = callPeakAPI('get', '/contacts', null, { code: invCode });
      const contacts = getRes && getRes.PeakContacts && getRes.PeakContacts.contacts;
      const c = Array.isArray(contacts) ? contacts[0] : contacts;
      if (!c || !(c.id || c.contactId || c.Id)) {
        Logger.log(`Fix [${invCode}]: ไม่พบ contact ใน PEAK — ข้าม`);
        countSkip++;
        continue;
      }
      if (c.name === correctName) { countSkip++; continue; }

      const oldName = c.name;
      const payload = Object.assign({}, c, { name: correctName });
      callPeakAPI('put', '/contacts', { PeakContacts: { contacts: [payload] } });
      Logger.log(`Fixed [${invCode}]: "${oldName}" → "${correctName}"`);
      countOk++;
    } catch (e) {
      Logger.log(`Fix failed [${invCode}]: ${e.message}`);
      countError++;
    }
  }

  PropertiesService.getScriptProperties().deleteProperty(CONTACT_CACHE_KEY_);

  const tail = stoppedEarly ? ' ⏸️ หมดเวลา — รันซ้ำเพื่อทำต่อ' : '';
  const summary = `Fix contact names เสร็จ — แก้: ${countOk}, ข้าม: ${countSkip}, Error: ${countError}${tail}`;
  toast(summary, 'FinFin', 10);
  Logger.log(summary);
  return summary;
}

/**
 * ทดสอบแก้ชื่อ 1 contact (run ก่อน runFixContactNames เพื่อ verify PUT endpoint)
 */
function testFixOneContact() {
  const invCode = '1754102677';  // เปลี่ยนเป็นรหัสจริงในชีท
  const newName = 'นายธัชกร โพธิจักร์';

  const getRes = callPeakAPI('get', '/contacts', null, { code: invCode });
  const c = getRes.PeakContacts.contacts[0];
  Logger.log(`Current: ${c.name} (id=${c.id})`);

  const payload = Object.assign({}, c, { name: newName });
  const putRes = callPeakAPI('put', '/contacts', { PeakContacts: { contacts: [payload] } });
  Logger.log(`PUT response: ${JSON.stringify(putRes).slice(0, 400)}`);
}

/**
 * Probe endpoints — หา endpoint ที่ใช้อัปเดต contact ได้จริง
 * รันแล้วดู log → มองหา HTTP 200 ที่ response มี id หรือ resCode=200
 * จากนั้นไปเช็คใน PEAK UI ว่าชื่ออัปเดตจริงหรือไม่
 */
function probeContactUpdate() {
  const invCode = '1754102677';  // เปลี่ยนเป็นรหัสจริงในชีท
  const newName = 'นายธัชกร โพธิจักร์ (probe)';

  const getRes = callPeakAPI('get', '/contacts', null, { code: invCode });
  const c = getRes.PeakContacts.contacts[0];
  if (!c) { Logger.log('ไม่พบ contact'); return; }
  Logger.log(`Probing for [${invCode}] id=${c.id} oldName="${c.name}"`);

  const fullBody = Object.assign({}, c, { name: newName });
  const minBody  = { id: c.id, code: c.code, name: newName, type: c.type };

  const candidates = [
    { method: 'put',   path: `/contacts/${c.id}`,         body: { PeakContacts: { contacts: [fullBody] } } },
    { method: 'put',   path: `/contacts/${c.id}`,         body: fullBody },
    { method: 'post',  path: `/contacts/${c.id}`,         body: { PeakContacts: { contacts: [fullBody] } } },
    { method: 'put',   path: `/contacts/${invCode}`,      body: { PeakContacts: { contacts: [fullBody] } } },
    { method: 'put',   path: '/contacts/update',          body: { PeakContacts: { contacts: [fullBody] } } },
    { method: 'post',  path: '/contacts/update',          body: { PeakContacts: { contacts: [fullBody] } } },
    { method: 'patch', path: `/contacts/${c.id}`,         body: { PeakContacts: { contacts: [fullBody] } } },
    { method: 'put',   path: '/contacts',                 body: { PeakContacts: { contacts: [minBody]  } } },
  ];

  for (const cand of candidates) {
    try {
      const url = CONFIG.BASE_URL + cand.path;
      const res = UrlFetchApp.fetch(url, {
        method:             cand.method,
        headers:            buildHeaders(),
        contentType:        'application/json',
        payload:            JSON.stringify(cand.body),
        muteHttpExceptions: true,
      });
      const code = res.getResponseCode();
      const body = res.getContentText().slice(0, 250);
      Logger.log(`${cand.method.toUpperCase()} ${cand.path} → HTTP ${code}: ${body}`);
    } catch (e) {
      Logger.log(`${cand.method.toUpperCase()} ${cand.path} → ERROR: ${e.message}`);
    }
    Utilities.sleep(500);
  }
  Logger.log('— Probe เสร็จ — เข้าไปเช็คใน PEAK UI ว่าชื่อ contact เปลี่ยนเป็น "...(probe)" หรือไม่');
}

/**
 * สร้าง contact ทดสอบ 3 รายการ (นาย / น.ส. / นาง) แล้ว GET กลับมาดู
 * → verify ว่า PEAK บันทึก prefixNameType + firstName + lastName ตามที่ส่งหรือไม่
 *
 * เช็คผลใน 2 ที่:
 *   1. Log นี้ — ดูค่า prefixNameType / firstName / lastName ที่ PEAK เก็บ
 *   2. PEAK UI → ผู้ติดต่อ → search "TST-" → ดู dropdown คำนำหน้า + ช่องชื่อ-นามสกุล
 *
 * Cleanup: ลบ contact ทดสอบใน PEAK UI หลังเทสเสร็จ (API ไม่รองรับ DELETE)
 */
function debugCreateTestContacts() {
  const ts = Date.now();
  const tests = [
    { code: `TST-KHN-${ts}`,  name: 'คุณทดสอบ หนึ่ง',   expected: 'คุณ (code=1)' },
    { code: `TST-NAI-${ts}`,  name: 'นายทดสอบ สอง',     expected: 'นาย (code=2)' },
    { code: `TST-NAA-${ts}`,  name: 'นางทดสอบ สาม',     expected: 'นาง (code=3)' },
    { code: `TST-NSA-${ts}`,  name: 'น.ส.ทดสอบ สี่',    expected: 'นางสาว (code=4)' },
  ];

  // ล้าง cache เพื่อให้ POST จริง ไม่ใช่ skip
  PropertiesService.getScriptProperties().deleteProperty(CONTACT_CACHE_KEY_);

  const codeNameMap = {};
  tests.forEach(t => codeNameMap[t.code] = t.name);
  ensureContactsBatch_(codeNameMap);

  Utilities.sleep(1500);

  for (const t of tests) {
    const res = callPeakAPI('get', '/contacts', null, { code: t.code });
    Logger.log(`=== expected: ${t.expected} ===`);
    Logger.log(JSON.stringify(res, null, 2));
  }
  Logger.log('--- เช็ค 2 จุด:');
  Logger.log('--- 1. PEAK UI → ผู้ติดต่อ → ค้นหา "TST-" → คลิกเข้าไป → ดู: คำนำหน้า ตรง expected, ชื่อจริง=ทดสอบ, นามสกุล=หนึ่ง/สอง/สาม/สี่');
  Logger.log('--- 2. สร้าง invoice ทดสอบจาก contact นี้ → ดูใน list ว่ามี prefix นำหน้าหรือเปล่า (สำคัญ!)');
}

function testGetContact() {
  const invCode = '1752485138';
  const res = callPeakAPI('get', '/contacts', null, { code: invCode });
  Logger.log(JSON.stringify(res, null, 2));
}

function debugContactCreate() {
  const invCode = '1752485138';
  const name    = 'ทดสอบลูกค้า';
  const url = CONFIG.BASE_URL + '/contacts/';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: buildHeaders(),
    contentType: 'application/json',
    payload: JSON.stringify({
      PeakContacts: { contacts: [{ code: invCode, name, type: 5 }] },
    }),
    muteHttpExceptions: true,
  });
  Logger.log('HTTP: ' + res.getResponseCode());
  Logger.log('BODY: ' + res.getContentText());
}

/**
 * ทดสอบ _parseThaiName_ + POST contact จริงไปยัง PEAK สำหรับ prefix "อื่น ๆ"
 *
 * Phase 1 — parse เท่านั้น (ไม่เรียก API):
 *   ดู log แต่ละชื่อว่า prefixNameType / prefixNameOther / firstName / lastName ถูกต้องไหม
 *
 * Phase 2 — POST contact ไปยัง PEAK:
 *   สร้าง contact จริงแบบ code "TST-OTH-..." แล้ว GET กลับมาดู
 *   เช็ค PEAK UI → ผู้ติดต่อ → search "TST-OTH" → ดู dropdown คำนำหน้า
 *   ลบ contact ทดสอบใน PEAK UI หลังเทสเสร็จ
 *
 * ตั้งค่า CREATE_IN_PEAK = false ถ้าต้องการทดสอบ parse อย่างเดียวก่อน
 */
function debugProbeContactTypes() {
  const CREATE_IN_PEAK = true;  // เปลี่ยนเป็น false ถ้าต้องการดู parse อย่างเดียว

  const cases = [
    { name: 'ว่าที่ ร.ต.หญิง ฌญาภัชน์ รอดพ้น',  expectPrefix: 'ว่าที่ ร.ต.หญิง', expectFirst: 'ฌญาภัชน์' },
    { name: 'นพ.สมชาย ดีมาก',                    expectPrefix: 'นพ.',              expectFirst: 'สมชาย'   },
    { name: 'ทพ.สมหญิง มีสุข',                   expectPrefix: 'ทพ.',              expectFirst: 'สมหญิง'  },
    { name: 'พล.ต.ท.สมศักดิ์ เก่งมาก',           expectPrefix: 'พล.ต.ท.',          expectFirst: 'สมศักดิ์' },
    { name: 'ด.ต.สุวรรณ ภักดี',                  expectPrefix: 'ด.ต.',             expectFirst: 'สุวรรณ'  },
    { name: 'นายสมศักดิ์ ทองดี',                  expectPrefix: '',                  expectFirst: 'สมศักดิ์' },
    { name: 'น.ส.มาลี ใจดี',                      expectPrefix: '',                  expectFirst: 'มาลี'    },
  ];

  Logger.log('=== Phase 1: Parse test ===');
  for (const c of cases) {
    const r = _parseThaiName_(c.name);
    const ok = r.prefixNameOther === c.expectPrefix && r.firstName === c.expectFirst;
    Logger.log(
      `${ok ? '✅' : '❌'} "${c.name}"\n` +
      `   → type=${r.prefixNameType} other="${r.prefixNameOther}" first="${r.firstName}" last="${r.lastName}"\n` +
      `   → expect: other="${c.expectPrefix}" first="${c.expectFirst}"`
    );
  }

  if (!CREATE_IN_PEAK) { Logger.log('CREATE_IN_PEAK=false — หยุดแค่ parse'); return; }

  Logger.log('\n=== Phase 2: POST to PEAK ===');
  const ts = Date.now();
  const customCases = cases.filter(c => c.expectPrefix !== '');  // เฉพาะ "อื่น ๆ"

  PropertiesService.getScriptProperties().deleteProperty(CONTACT_CACHE_KEY_);

  const codeNameMap = {};
  customCases.forEach((c, i) => { codeNameMap[`TST-OTH-${i}-${ts}`] = c.name; });
  ensureContactsBatch_(codeNameMap);
  Utilities.sleep(1500);

  for (let i = 0; i < customCases.length; i++) {
    const code = `TST-OTH-${i}-${ts}`;
    try {
      const res = callPeakAPI('get', '/contacts', null, { code });
      const contacts = res && res.PeakContacts && res.PeakContacts.contacts;
      const c = Array.isArray(contacts) ? contacts[0] : contacts;
      Logger.log(`[${code}] name="${customCases[i].name}"`);
      Logger.log(`  PEAK returned: prefixNameType=${c && c.prefixNameType} prefixNameOther="${c && c.prefixNameOther}" firstName="${c && c.firstName}" lastName="${c && c.lastName}"`);
    } catch (e) {
      Logger.log(`[${code}] GET error: ${e.message}`);
    }
  }
  Logger.log('--- เสร็จ — ไปลบ contact TST-OTH-* ใน PEAK UI หลังเทสเสร็จ ---');
}
