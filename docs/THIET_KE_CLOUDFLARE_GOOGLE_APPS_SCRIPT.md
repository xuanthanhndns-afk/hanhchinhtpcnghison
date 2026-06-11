# Thiet ke phien ban Cloudflare Pages + Google Apps Script

Muc tieu: thiet ke he thong quan ly com ca theo mo hinh website mau `doicanhienlieu.pages.dev`.

## Kien truc

```text
Nguoi dung
  -> Cloudflare Pages
       - Chay giao dien web tinh HTML/CSS/JS
       - Khong can server Node.js
  -> Google Apps Script Web App
       - Xu ly API dang action
       - Xac thuc dang nhap
       - Ghi/Doc du lieu
       - Gui Telegram neu co token
  -> Google Sheets / Google Drive
       - Luu du lieu nghiep vu
       - Co the backup thanh file trong Drive
```

## So sanh voi ban hien tai

| Hang muc | Ban hien tai | Ban theo web mau |
|---|---|---|
| Noi chay giao dien | Render hoac Cloudflare Pages | Cloudflare Pages |
| Backend | Node.js/Cloudflare Function | Google Apps Script |
| Database | Neon PostgreSQL hoac Cloudflare D1 | Google Sheet |
| Muc do de quan tri | Trung binh | De xem/sua bang tinh |
| Do ben du lieu | Cao hon | Phu thuoc Google Sheet/API |
| Xu ly dong thoi | Tot hon | Can LockService de tranh ghi de |

## Khuyen nghi trien khai

Khong nen thay the ngay ban dang chay. Nen tao mot ban song song:

```text
Ban on dinh: Render + Neon hoac Cloudflare D1
Ban thu nghiem: Cloudflare Pages + Google Apps Script + Google Sheet
```

Khi ban thu nghiem chay on dinh 1-2 tuan thi moi chuyen chinh thuc.

## Cau truc Google Sheet de xuat

Ten file Google Sheet:

```text
COM_CA_TPCNGHISON_DB
```

Sheet `State`:

| Cot | Noi dung |
|---|---|
| A1 | Chuoi JSON toan bo database |

Giai doan 1 dung `State!A1` de luu toan bo database JSON. Cach nay don gian, gan voi code hien tai, de backup. Khi du lieu lon hon se tach thanh cac sheet rieng:

- `Users`
- `Chefs`
- `Menus`
- `Orders`
- `Payments`
- `BankStatements`
- `AuditLogs`

## Cac API action chinh

Frontend Cloudflare Pages se goi Google Apps Script bang `POST`:

```json
{
  "action": "login",
  "loginId": "admin",
  "password": "123456"
}
```

Danh sach action:

| Action | Chuc nang |
|---|---|
| `login` | Dang nhap |
| `logout` | Dang xuat |
| `me` | Lay user hien tai |
| `bootstrap` | Lay settings, users, menus, chefs |
| `importWorkers` | Nhap danh sach thanh vien |
| `deleteWorker` | Xoa thanh vien |
| `resetWorkerPassword` | Dat lai mat khau |
| `saveChef` | Them/sua dau bep |
| `deleteChef` | Xoa dau bep |
| `changePassword` | Doi mat khau |
| `saveTelegram` | Luu Telegram Chat ID |
| `saveMenu` | Luu dinh luong bua an |
| `registerOrder` | Dang ky com |
| `cancelOrder` | Huy dang ky |
| `dailyReport` | Bao cao ngay |
| `monthlyReport` | Cong no thang |
| `markPaid` | Danh dau da thanh toan |
| `reconcileCsv` | Doi soat sao ke CSV |
| `telegramRemind` | Nhac Telegram va khoa qua han |

## Bao mat

Can dung cac bien trong Apps Script Properties:

```text
SHEET_ID = id_google_sheet
TELEGRAM_BOT_TOKEN = token_bot_neu_dung
```

Nguyen tac:

- Khong public token Telegram trong file HTML.
- Khong luu mat khau quan tri trong code frontend.
- Apps Script can dung `LockService` khi ghi du lieu de tranh 2 nguoi thao tac cung luc lam ghi de.
- Google Sheet chi chia se quyen edit cho admin he thong.

## Cac buoc trien khai

1. Tao Google Sheet ten `COM_CA_TPCNGHISON_DB`.
2. Mo `Extensions` > `Apps Script`.
3. Dan noi dung file `google-apps-script/Code.gs` vao Apps Script.
4. Chay ham `setup()` mot lan de khoi tao sheet `State`.
5. Vao `Project Settings` > `Script Properties`, them:

```text
SHEET_ID = id_google_sheet
TELEGRAM_BOT_TOKEN = token_bot_neu_dung
```

6. Deploy Apps Script:

```text
Deploy > New deployment > Web app
Execute as: Me
Who has access: Anyone
```

7. Copy URL `/exec`.
8. Gan URL do vao Cloudflare Pages frontend.

## Ghi chu quan trong

Google Sheet phu hop giai doan nho, can quan tri truc quan. Neu so luong dang ky hang ngay lon, can dong thoi nhieu nguoi, hoac can bao cao nhanh lau dai thi Cloudflare D1/Neon van tot hon.

