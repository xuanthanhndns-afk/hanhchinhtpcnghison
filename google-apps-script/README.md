# Google Apps Script backend mau

Thu muc nay dung cho phien ban thiet ke theo website mau:

```text
Cloudflare Pages + Google Apps Script + Google Sheet
```

## Cach dung

1. Tao Google Sheet moi.
2. Mo `Extensions` > `Apps Script`.
3. Dan noi dung `Code.gs` vao Apps Script.
4. Trong Apps Script, them Script Properties:

```text
SHEET_ID = id_google_sheet
TELEGRAM_BOT_TOKEN = token_bot_neu_dung
```

5. Chay ham `setup()` mot lan.
6. Deploy thanh Web App.

Day la khung backend ban dau. Khi chot chuyen han sang Google Sheet, can map frontend hien tai sang cac action trong file nay.

