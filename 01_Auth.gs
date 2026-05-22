/**
 * FinFin Automation — Authentication & PEAK API Headers
 *
 * PEAK Auth Flow:
 *  1. สร้าง Time-Stamp (yyyyMMddHHmmss)
 *  2. สร้าง Time-Signature = HMAC-SHA1(Time-Stamp, CONNECT_ID) → hex
 *  3. POST /ClientToken → ได้ Client-Token (อายุ 24 ชม.)
 *  4. แนบ headers ทุก request: Time-Stamp, Time-Signature, Client-Token, User-Token
 */

// ─── Time-Stamp ──────────────────────────────────────────────────────────────
function buildTimeStamp() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return (
    now.getUTCFullYear() +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds())
  );
}

// ─── HMAC-SHA1 Signature ─────────────────────────────────────────────────────
function hmacSha1Hex(message, key) {
  const bytes = Utilities.computeHmacSignature(
    Utilities.MacAlgorithm.HMAC_SHA_1,
    message,
    key
  );
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

// ─── Client Token (cached 23 ชม.) ───────────────────────────────────────────────
function getClientToken() {
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty('PEAK_CLIENT_TOKEN');
  const cachedAt = props.getProperty('PEAK_CLIENT_TOKEN_TS');

  if (cached && cachedAt) {
    const age = Date.now() - Number(cachedAt);
    if (age < 23 * 60 * 60 * 1000) {
      return cached;
    }
  }

  const ts = buildTimeStamp();
  const sig = hmacSha1Hex(ts, CONFIG.CONNECT_ID);

  const url = `${CONFIG.BASE_URL}/clienttoken`;
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Time-Stamp': ts,
      'Time-Signature': sig,
    },
    payload: JSON.stringify({
      PeakClientToken: {
        connectId: CONFIG.CONNECT_ID,
        password:  CONFIG.CONNECT_PASSWORD,
      },
    }),
    muteHttpExceptions: true,
  };

  const res = UrlFetchApp.fetch(url, options);
  const data = JSON.parse(res.getContentText());

  const token = data && data.PeakClientToken && data.PeakClientToken.token;
  if (res.getResponseCode() !== 200 || !token) {
    throw new Error(`getClientToken failed: ${res.getContentText()}`);
  }

  props.setProperty('PEAK_CLIENT_TOKEN', token);
  props.setProperty('PEAK_CLIENT_TOKEN_TS', String(Date.now()));

  return token;
}

// ─── Build Request Headers ────────────────────────────────────────────────
function buildHeaders() {
  const ts = buildTimeStamp();
  const sig = hmacSha1Hex(ts, CONFIG.CONNECT_ID);
  const clientToken = getClientToken();

  // Content-Type ไม่ใส่ที่นี่ — ให้ callPeakAPI ตั้งผ่าน options.contentType แยก
  return {
    'Time-Stamp': ts,
    'Time-Signature': sig,
    'Client-Token': clientToken,
    'User-Token': CONFIG.USER_TOKEN,
  };
}

// ─── Generic API Caller ─────────────────────────────────────────────────────
function callPeakAPI(method, path, payload, params) {
  let url = CONFIG.BASE_URL + path;

  if (params && Object.keys(params).length > 0) {
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    url += '?' + qs;
  }

  const options = {
    method: method.toLowerCase(),
    headers: buildHeaders(),
    muteHttpExceptions: true,
  };

  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }

  let res = UrlFetchApp.fetch(url, options);
  let code = res.getResponseCode();
  let text = res.getContentText();

  // ─── 429 Retry: concurrency limit แก้ได้ภายในไม่กี่วินาที ──────────────────
  if (code === 429) {
    let parsed429 = {};
    try { parsed429 = JSON.parse(text); } catch (_) {}
    const limitType    = parsed429.type || 'rate';  // "concurrency" | "rate"
    const retryAfterSec = parsed429.retryAfterSeconds;

    if (limitType === 'concurrency' || retryAfterSec === null || retryAfterSec === undefined) {
      // Concurrency 429: request อื่นกำลัง in-flight — รอแล้ว retry 1 ครั้ง
      Logger.log(`PEAK concurrency limit on ${method.toUpperCase()} ${path} — retry in 8s`);
      Utilities.sleep(8000);
      res  = UrlFetchApp.fetch(url, options);
      code = res.getResponseCode();
      text = res.getContentText();
    }
    // Rate 429 (retryAfterSeconds=60): หยุด run ทันที — ไม่ retry inline
    // code/text ยังคงเป็น 429 → โค้ดด้านล่างจะ throw → classifyError_='quota'
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = { raw: text };
  }

  if (code !== 200) {
    throw new Error(`PEAK API ${method.toUpperCase()} ${path} → HTTP ${code}: ${text}`);
  }

  if (data && (data.isSuccess === false || data.success === false)) {
    const errMsg = data.message || data.errorMessage || data.error || text;
    throw new Error(`PEAK API error: ${errMsg}`);
  }

  const topKey = data && Object.keys(data)[0];
  if (topKey && data[topKey]) {
    const inner = data[topKey];
    const firstItem = Array.isArray(inner.receipts)   ? inner.receipts[0]
                    : Array.isArray(inner.invoices)   ? inner.invoices[0]
                    : Array.isArray(inner.creditNotes) ? inner.creditNotes[0]
                    : null;
    const resCode = (firstItem && firstItem.resCode) || inner.resCode;
    if (resCode && String(resCode) !== '200') {
      const resDesc = (firstItem && firstItem.resDesc) || inner.resDesc || text;
      throw new Error(`PEAK API ${resCode}: ${resDesc}`);
    }
  }

  return data;
}

function debugAllinone() {
  const payload = {
    code:         'DEBUG-TEST-001',
    issuedDate:   '20260310',
    dueDate:      '20260310',
    contactCode:  '1752485138',
    isTaxInvoice: true,
    remark:       'ทดสอบ debug',
    products: [{
      accountCode: CONFIG.ACCOUNT_CODE_SALES,
      description: 'ทดสอบ',
      quantity:    1,
      price:       100,
      vatType:     CONFIG.VAT_TYPE_7,
    }],
    paidPayments: {
      paymentDate:    '20260310',
      paymentMethods: [{ type: CONFIG.PMT_TRANSFER, amount: 107 }],
    },
  };
  const res = UrlFetchApp.fetch(CONFIG.BASE_URL + '/receipts/allinone', {
    method: 'post',
    headers: buildHeaders(),
    contentType: 'application/json',
    payload: JSON.stringify({ PeakReceipts: { receipts: [payload] } }),
    muteHttpExceptions: true,
  });
  Logger.log('HTTP: ' + res.getResponseCode());
  Logger.log('BODY: ' + res.getContentText());
}

function resetClientTokenCache() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('PEAK_CLIENT_TOKEN');
  props.deleteProperty('PEAK_CLIENT_TOKEN_TS');
  Logger.log('Client Token cache cleared.');
}

function testGetPaymentMethods() {
  const data = callPeakAPI('get', '/paymentmethods', null, { page: 1 });
  Logger.log(JSON.stringify(data, null, 2));
}

// ─── Sandbox Cleanup: ลอง DELETE/VOID เอกสารทีละใบ ──────────────────────────
// ⚠️  ใช้เฉพาะใน UAT เท่านั้น ห้ามรันใน production
// PEAK API อาจไม่รองรับ DELETE (กฎหมายไทย) — function นี้จะลองหลาย endpoint
// ถ้าเจอ endpoint ที่ work → ใช้ cleanupTestDocs() ลบ bulk ได้

function probeDeleteEndpoint(docCode) {
  if (!docCode) {
    Logger.log('Usage: probeDeleteEndpoint("IVF-260331001")');
    return;
  }

  const candidates = [
    { method: 'delete', path: `/receipts/${docCode}`,        params: null },
    { method: 'delete', path: '/receipts',                   params: { code: docCode } },
    { method: 'post',   path: `/receipts/${docCode}/void`,   params: null, payload: {} },
    { method: 'post',   path: `/receipts/${docCode}/cancel`, params: null, payload: {} },
    { method: 'post',   path: '/receipts/void',              params: null, payload: { code: docCode } },
    { method: 'put',    path: `/receipts/${docCode}`,        params: null, payload: { status: 'cancelled' } },
  ];

  for (const c of candidates) {
    try {
      const url = CONFIG.BASE_URL + c.path + (c.params
        ? '?' + Object.entries(c.params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
        : '');
      const options = {
        method: c.method,
        headers: buildHeaders(),
        muteHttpExceptions: true,
      };
      if (c.payload) {
        options.contentType = 'application/json';
        options.payload = JSON.stringify(c.payload);
      }
      const res = UrlFetchApp.fetch(url, options);
      const code = res.getResponseCode();
      const body = res.getContentText().slice(0, 200);
      Logger.log(`${c.method.toUpperCase()} ${c.path} → HTTP ${code}: ${body}`);
      if (code === 200) {
        Logger.log(`✅ FOUND working endpoint: ${c.method.toUpperCase()} ${c.path}`);
        return c;
      }
    } catch (e) {
      Logger.log(`${c.method.toUpperCase()} ${c.path} → ERROR: ${e.message}`);
    }
  }
  Logger.log('❌ ไม่มี endpoint ใดทำงาน — DELETE/VOID น่าจะไม่รองรับใน sandbox');
  return null;
}

/**
 * ⚠️  Sandbox cleanup: ลบ test documents ทั้งหมดจาก Log Sheet
 * ต้องรัน probeDeleteEndpoint() ก่อนเพื่อหา endpoint ที่ใช้ได้
 * แล้วเอามาใส่ใน workingEndpoint
 */
function cleanupTestDocs(workingEndpoint) {
  if (!workingEndpoint) {
    throw new Error('ต้องระบุ workingEndpoint จาก probeDeleteEndpoint() ก่อน เช่น { method:"delete", path:"/receipts/{code}" }');
  }

  const log = getLogSheet();
  const data = log.getDataRange().getValues();
  // คอลัมน์ใน Log: [Date, Part, Sheet, Row, INV, Status, DocNo, Msg]
  const docs = data.slice(1)
    .filter(r => String(r[5]).toUpperCase() === 'SUCCESS' && r[6])
    .map(r => String(r[6]).split(' / ')[0].trim())
    .filter(Boolean);

  Logger.log(`พบ ${docs.length} เอกสารใน Log จะลอง void/delete`);
  let ok = 0, err = 0;

  for (const docCode of docs) {
    try {
      const path = workingEndpoint.path.replace('{code}', docCode);
      const params = workingEndpoint.params
        ? Object.fromEntries(Object.entries(workingEndpoint.params).map(([k, v]) => [k, v === '{code}' ? docCode : v]))
        : null;
      callPeakAPI(workingEndpoint.method, path, workingEndpoint.payload || null, params);
      ok++;
    } catch (e) {
      Logger.log(`Failed ${docCode}: ${e.message}`);
      err++;
    }
  }
  Logger.log(`Cleanup เสร็จ — สำเร็จ: ${ok}, ล้มเหลว: ${err}`);
}
