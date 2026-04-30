# FinFin Desktop Client — Setup

## 1. ฝั่ง GAS (ทำครั้งเดียว)

1. เปิด Google Sheet → Extensions → Apps Script
2. Copy ไฟล์ `.gs` ทั้งหมดไปใส่ใน project
3. รันฟังก์ชัน `setupWebAppApiKey('<ตั้งรหัสเอง>')` ครั้งเดียว
   เช่น `setupWebAppApiKey('finfin-secret-2026')`
4. Deploy → New deployment → Web app
   - Execute as: Me (เจ้าของ sheet)
   - Who has access: **Anyone**
   - Copy URL `.../exec` เก็บไว้ (เช่น `https://script.google.com/macros/s/AKfycb.../exec`)

⚠ ถ้า update GAS code แล้ว ต้อง Deploy → Manage deployments → Edit → New version

## 2. ฝั่ง Dev — Build .exe

Requirements: Python 3.11+

```bat
cd finfin_client
build.bat
```

ได้ไฟล์ `dist\FinFin.exe` → ส่งให้ลูกค้า

## 3. ฝั่งลูกค้า — ใช้งาน

1. Double-click `FinFin.exe`
   - ถ้า Windows SmartScreen แจ้ง → "More info" → "Run anyway"
2. เปิดแอป → ไปหน้า **Settings**
   - กรอก **GAS Web App URL** (จากข้อ 1.4)
   - กรอก **API Key** (จากข้อ 1.3)
   - กรอก PEAK credentials + Spreadsheet ID
   - กด **Save Local** → **Push to GAS**
3. ไปหน้า **Tasks** → กดปุ่มที่ต้องการ

Config file: `%APPDATA%\FinFin\config.json`
