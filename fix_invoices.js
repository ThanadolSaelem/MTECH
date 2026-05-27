/**
 * รัน: node fix_invoices.js
 * ต้องมี invoices_to_fix.json จาก collect_invoices.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const EMI = 'NTIxMjIy';
const IN_FILE  = path.join(__dirname, 'invoices_to_fix.json');
const LOG_FILE = path.join(__dirname, 'progress_invoice_notes.json');
const HEADLESS = false;
const INVOICE_LIST_URL = `https://secure.peakaccount.com/income/invoice?emi=${EMI}&stid=-1`;
const SEARCH_SEL = 'input[placeholder="ค้นหาด้วยชื่อ, เลขที่"]';

const COOKIE_STRING = '_gcl_au=1.1.1649024398.1777367443; __lt__cid=11c3bed9-c324-476d-9756-fdb74d84afb1; _tt_enable_cookie=1; _ttp=01KQ9NNXP9P95T1AMZBZ0BYJ59_.tt.1; _fbp=fb.1.1777367449525.263667945252253832; _hjSessionUser_2785836=eyJpZCI6ImUyOGVkMjcwLWYwNmUtNTNjZS1iZDk5LWVjZGQxMjgxNDdmZiIsImNyZWF0ZWQiOjE3NzczNjc0NDU3MTEsImV4aXN0aW5nIjp0cnVlfQ==; intercom-device-id-q5pg9p6b=52ae3e86-f6d4-4f55-8ed1-6b873a3c96b6; hubspotutk=4fa5b4c48b18d25fce9ea7ac4b4564cc; _gcl_gs=2.1.k1$i1778824901$u233644828; _gac_UA-70444895-1=1.1778824910.CjwKCAjw5ZXQBhBdEiwAI5XVWUb3NigREH9QLudG4NQHUmD69fjptS8rem7X_gFeArxyFRcJY5_N7BoCKT8QAvD_BwE; _gcl_aw=GCL.1778824952.CjwKCAjw5ZXQBhBdEiwAI5XVWUb3NigREH9QLudG4NQHUmD69fjptS8rem7X_gFeArxyFRcJY5_N7BoCKT8QAvD_BwE; __hssrc=1; _gid=GA1.2.786232257.1779797136; prism_66613342=7321bdfc-ea44-4b27-90f4-1a255920a35c; _ga_89V03SRLCH=GS2.1.s1779797136$o1$g0$t1779797138$j58$l0$h0; hideTooltipVideo-NTQ2MjQw=true; _clck=506dks%5E2%5Eg6e%5E0%5E2309; _hjSession_2785836=eyJpZCI6ImMxMWJlZTRhLWM1NzUtNGY5Zi1hOWZjLTQyYTUyYjI1NjdjZSIsImMiOjE3Nzk4NjgxNjkzNDMsInMiOjAsInIiOjAsInNiIjowLCJzciI6MCwic2UiOjAsImZzIjowfQ==; __lt__sid=6f288136-d845b6a8; __hstc=96316035.4fa5b4c48b18d25fce9ea7ac4b4564cc.1777522549114.1779867329492.1779875880713.12; _gat_UA-70444895-1=1; g_state={"i_l":0,"i_ll":1779875891693,"i_e":{"enable_itp_optimization":0},"i_et":1777367447771}; keepLogin=true; access_token=3126D838D6EABC505CAB6E628612C65BBFCC7D21D610EB47C0BEAE1DC608A200; refresh_token=C1AA5F0234BAD7ECBADC49DA442D00DE90CAEBD6CAB0F6497A2658F49BE296DE; Y2hlY2tfb2xkX3B3ZF9oYXNo={%22aXNPbGRQYXNzd29yZEhhc2hpbmc=%22:false}; _ga_W44VHJWBXS=GS2.1.s1779875876$o15$g1$t1779875899$j37$l0$h0; _ga_D2LCMQRCYB=GS2.1.s1779875876$o15$g1$t1779875899$j37$l0$h0; ttcsid=1779875880147::xU-l3HluqWaoHE50gCio.13.1779875900256.0::1.19157.19901::19143.3.1025.374::0.0.0; ttcsid_CKD34SBC77U17F5D7M0G=1779875880146::N2RMJSOAsGGHyeR1qHg7.11.1779875900256.1; ttcsid_D4EP2PJC77UBVM8PBEE0=1779875880148::a9-4gNSszbQyxHm3Sc2x.11.1779875900256.1; __hssc=96316035.3.1779875880713; _ga_TSVL71V0D8=GS2.1.s1779875876$o13$g1$t1779875900$j36$l0$h0; _ga_8V8WC4CZ8N=GS2.1.s1779875877$o15$g1$t1779875900$j37$l0$h0; _ga=GA1.2.1289834234.1777367444; _clsk=1qd0ssb%5E1779875900510%5E6%5E1%5Ex.clarity.ms%2Fcollect; _clsk=1qd0ssb%5E1779875900510%5E6%5E1%5Ex.clarity.ms%2Fcollect; _clsk=1qd0ssb%5E1779875900510%5E6%5E1%5Ex.clarity.ms%2Fcollect; intercom-session-q5pg9p6b=VXBFWWYrVStPUEdzOGRUdTJkRVRkT2Q1TVltUTg5ZGRUZGRuNUt6TG5LdFlZQlVPZGVuV1dDOTIzVXY2eDhjdFR6aXFSNE5CT2pYR1IyREg0YU4rOVAwUHlBS1JNYmhRNnBkUHA2bFdRcjVNYlRqNDRndVBMVFF6dDRKeXBLREN4YUxLQ1Awd25iK1ZMemtLRHcwWVUrTGlOTjlJMXg5ekxBQWVBUkluM2hoRVpJdHpyVVNpVGVhOUJxcUpnZ0FYKzhHbGRGSVNQMUNxemFGbGRZVjUrUT09LS0yMDV4K202dDh4cFRXWFBOL2x2L3VnPT0=--e93d4fc163005ffc787be1656dc9610349ca7d60; _dd_s=rum=0&expire=1779876799826';

const wait = (ms = 600) => new Promise(r => setTimeout(r, ms));

if (!fs.existsSync(IN_FILE)) {
  console.error('❌ ไม่พบ invoices_to_fix.json — รัน collect_invoices.js ก่อน');
  process.exit(1);
}
const items = JSON.parse(fs.readFileSync(IN_FILE, 'utf-8'));
console.log(`📋 โหลด ${items.length} invoices`);

let progress = {};
if (fs.existsSync(LOG_FILE)) {
  progress = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
  const done = Object.values(progress).filter(v => v === 'done').length;
  console.log(`↩️  Resume: ${done} ทำแล้ว\n`);
}
const saveProgress = () => fs.writeFileSync(LOG_FILE, JSON.stringify(progress, null, 2));

function makeCookies() {
  return COOKIE_STRING.split(';').map(c => {
    const [n, ...v] = c.trim().split('=');
    return { name: n.trim(), value: v.join('=').trim(), domain: 'secure.peakaccount.com', path: '/' };
  }).filter(c => c.name);
}

async function gotoList(page) {
  await page.goto(INVOICE_LIST_URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector(SEARCH_SEL, { timeout: 30000 });
}

// Selectors (verified by user)
const EDIT_BTN_SEL  = '#recordExternalDocumentDetail > div > div > div:nth-child(2) > span';
const NOTE_INPUT_SEL = '[id="หมายเหตุสำหรับลูกค้า"]';  // id ภาษาไทย → ใช้ attr selector
const SAVE_BTN_SEL  = '#quickEditTool > div > div > div > div.edit';

async function fixNote(page, invCode, expectedNote) {
  // 1. ไปหน้า list + search
  await gotoList(page);
  const sb = page.locator(SEARCH_SEL).first();
  await sb.click({ clickCount: 3 });
  await sb.fill(invCode);
  await sb.press('Enter');

  // รอ p.cropNumber.textBlue โหลดหลัง search
  await page.waitForSelector('p.cropNumber.textBlue', { timeout: 15000 });
  await wait(500);

  // 2. คลิก invoice code → นำทางไป detail
  const codeEl = page.locator('p.cropNumber.textBlue').filter({ hasText: invCode }).first();
  if (await codeEl.count() === 0) throw new Error('ไม่พบ invoice ใน search results');
  await codeEl.click();

  // 3. รอ detail page โหลด (ดูจาก edit button)
  await page.waitForSelector(EDIT_BTN_SEL, { timeout: 15000 });
  await wait(800);

  // 4. scroll + คลิกปุ่ม "แก้ไข" (เปิด quickEditTool)
  const editBtn = page.locator(EDIT_BTN_SEL).first();
  await editBtn.scrollIntoViewIfNeeded();
  await editBtn.click();
  await wait(800);

  // 5. รอ textbox โผล่
  await page.waitForSelector('#quickEditTool', { timeout: 8000 });
  const noteInput = page.locator(NOTE_INPUT_SEL).first();
  await noteInput.waitFor({ timeout: 5000 });

  // อ่าน text เดิม (textbox อาจเป็น input หรือ textarea)
  const current = (await noteInput.inputValue().catch(async () =>
    (await noteInput.innerText().catch(() => '')))).trim();
  console.log(`   เดิม: "${current.slice(0, 70)}"`);

  if (current === expectedNote) {
    await page.keyboard.press('Escape').catch(() => {});
    return 'already_ok';
  }

  // 6. เปลี่ยน text
  await noteInput.click({ clickCount: 3 });
  await wait(100);
  await noteInput.fill(expectedNote);
  await wait(300);

  // 7. กด save
  const saveBtn = page.locator(SAVE_BTN_SEL).first();
  await saveBtn.waitFor({ timeout: 5000 });
  await saveBtn.click();
  await wait(2000);

  return 'fixed';
}

(async () => {
  const browser = await chromium.launch({ headless: HEADLESS, slowMo: 40 });
  const ctx = await browser.newContext({ locale: 'th-TH' });
  await ctx.addCookies(makeCookies());

  let page = await ctx.newPage();
  let countOk = 0, countSkip = 0, countErr = 0, consecutive = 0;

  for (let i = 0; i < items.length; i++) {
    const { invCode, expected } = items[i];
    if (progress[invCode] === 'done') { countSkip++; continue; }

    console.log(`\n▶ [${i + 1}/${items.length}] [${invCode}]`);
    console.log(`   ใหม่:  "${expected}"`);

    try {
      const result = await fixNote(page, invCode, expected);
      progress[invCode] = 'done';
      saveProgress();
      countOk++; consecutive = 0;
      console.log(`   ${result === 'fixed' ? '✅ แก้แล้ว' : '⏭️  ตรงอยู่แล้ว'}`);
    } catch (e) {
      progress[invCode] = `error: ${e.message.slice(0, 100)}`;
      saveProgress();
      countErr++; consecutive++;
      console.error(`   ❌ ${e.message.slice(0, 100)}`);

      // รีเซ็ต page ถ้า browser crash (Target closed)
      try {
        await page.screenshot({ path: path.join(__dirname, `err_${invCode}.png`) });
      } catch {
        console.log('   🔄 Page ปิดตัว — เปิดใหม่');
        try {
          page = await ctx.newPage();
        } catch {
          const b2 = await chromium.launch({ headless: HEADLESS, slowMo: 40 });
          const c2 = await b2.newContext({ locale: 'th-TH' });
          await c2.addCookies(makeCookies());
          page = await c2.newPage();
        }
      }

      if (consecutive >= 5) { console.error('\n🚨 Error ติดกัน 5 ครั้ง — หยุด'); break; }
    }
  }

  await browser.close().catch(() => {});
  console.log('\n' + '─'.repeat(48));
  console.log(`✅ Done  : ${countOk}`);
  console.log(`⏭️  Skip  : ${countSkip}`);
  console.log(`❌ Error : ${countErr}`);
  console.log('─'.repeat(48));
})();
