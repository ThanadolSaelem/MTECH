/**
 * FinFin Automation — Authentication & PEAK API Headers
 *
 * PEAK Auth Flow:
 *  1. สร้าง Time-Stamp (yyyyMMddHHmmss)
 *  2. สร้าง Time-Signature = HMAC-SHA1(Time-Stamp, CONNECT_ID) → hex
 *  3. POST /ClientToken → ได้ Client-Token (อายุ 24 ชม.)
 *  4. แนบ headers ทุก request: Time-Stamp, Time-Signature, Client-Token, User-Token
 */

// ─── Time-Stamp ─────────────────────────────────────────────────────────────
/**
 * สร้าง timestamp ในรูปแบบ yyyyMMddHHmmss (Bangkok time)
 * @returns {string}
 */
function buildTimeStamp() {
  const now = new Date();
  // แปลงเป็น Bangkok (UTC+7)
  const bkk = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return (
    bkk.getUTCFullYear() +
    pad(bkk.getUTCMonth() + 1) +
    pad(bkk.getUTCDate()) +
    pad(bkk.getUTCHours()) +
    pad(bkk.getUTCMinutes()) +
    pad(bkk.getUTCSeconds())
  );
}

// ─── HMAC-SHA1 Signature ─────────────────────────────────────────────────────
/**
 * คำนวณ HMAC-SHA1(message, key) → lowercase hex string
 * ใช้ GAS built-in Utilities.computeHmacSignature
 * @param {string} message
 * @param {string} key
 * @returns {string}
 */
function hmacSha1Hex(message, key) {
  const bytes = Utilities.computeHmacSignature(
    Utilities.MacAlgorithm.HMAC_SHA_1,
    message,
    key
  );
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

// ─── Client Token (cached 23 ชม.) ────────────────────────────────────────────
/**
 * ดึง Client-Token จาก cache ใน ScriptProperties
 * ถ้าหมดอายุหรือยังไม่มี → เรียก /ClientToken ใหม่
 * @returns {string} client token
 */
function getClientToken() {
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty('PEAK_CLIENT_TOKEN');
  const cachedAt = props.getProperty('PEAK_CLIENT_TOKEN_TS');

  if (cached && cachedAt) {
    const age = Date.now() - Number(cachedAt);
    if (age < 23 * 60 * 60 * 1000) {
      // ยังใช้ได้อยู่ (< 23 ชม.)
      return cached;
    }
  }

  // ต้องขอใหม่
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

// ─── Build Request Headers ────────────────────────────────────────────────────
/**
 * สร้าง headers สำหรับทุก PEAK API call
 * @returns {Object}
 */
function buildHeaders() {
  const ts = buildTimeStamp();
  const sig = hmacSha1Hex(ts, CONFIG.CONNECT_ID);
  const clientToken = getClientToken();

  // Content-Type ไม่ใส่ที่นี่ — ให้ callPeakAPI ตั้งผ่าน options.contentType แยก
  // เพื่อป้องกัน duplicate header ที่บาง server ปฏิเสธ
  return {
    'Time-Stamp': ts,
    'Time-Signature': sig,
    'Client-Token': clientToken,
    'User-Token': CONFIG.USER_TOKEN,
  };
}

// ─── Generic API Caller ───────────────────────────────────────────────────────
/**
 * เรียก PEAK API พร้อม headers อัตโนมัติ
 * @param {string} method  'get' | 'post'
 * @param {string} path    เช่น '/Receipts/queue'
 * @param {Object} [payload]
 * @param {Object} [params]  query string params
 * @returns {Object} parsed JSON response
 */
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

  const res = UrlFetchApp.fetch(url, options);
  const code = res.getResponseCode();
  const text = res.getContentText();

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = { raw: text };
  }

  // HTTP-level error
  if (code !== 200) {
    throw new Error(`PEAK API ${method.toUpperCase()} ${path} → HTTP ${code}: ${text}`);
  }

  // PEAK returns HTTP 200 even for application-level errors
  // ตรวจ error fields ที่พบบ่อยใน PEAK response
  if (data && (data.isSuccess === false || data.success === false)) {
    const errMsg = data.message || data.errorMessage || data.error || text;
    throw new Error(`PEAK API error: ${errMsg}`);
  }

  return data;
}

/**
 * รีเซ็ต Client Token cache (ใช้เมื่อ token ผิดพลาด)
 */
function resetClientTokenCache() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('PEAK_CLIENT_TOKEN');
  props.deleteProperty('PEAK_CLIENT_TOKEN_TS');
  Logger.log('Client Token cache cleared.');
}
