# He thong quan ly com ca cong nhan

Ban MVP web rieng, chay bang Node.js thuan, khong can cai package ngoai.

## Chay thu

Chay nhanh bang PowerShell:

```powershell
.\run_app.ps1
```

Hoac bam/chay:

```text
run_app.bat
```

Lenh truc tiep:

```powershell
& "C:\Users\TRAN THI NHUNG\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" server.js
```

Mo trinh duyet: `http://localhost:3000`

## Tai khoan mau

| Vai tro | Ma dang nhap | Mat khau |
|---|---|---|
| Admin | admin | 123456 |
| Nha bep | Nhabep | 123456 |
| Cong nhan | 0901000001 | 123456 |
| Cong nhan | 0901000002 | 123456 |

## Module co san

- Admin nhap danh sach cong nhan tu file Excel luu dang CSV, xem/xoa tai khoan cong nhan, quan ly dong tien tung account.
- Nha bep nhap/sua dinh luong tung mon an theo bua: so thu tu, ten mon, dinh luong gam, don gia, thanh tien, tong gia tri thuc don.
- Cong nhan dang ky/huy truoc 08h ngay an.
- Sau 08h chi nha bep duoc bo sung suat theo ma nhan vien.
- Cong nhan da dang ky nhung khong an van tinh tien.
- Tong hop cong no theo thang.
- Tao link QR VietQR theo tung cong nhan.
- Gui nhac Telegram neu cau hinh bot token va Telegram chat id.
- Nhap sao ke CSV de doi soat tu dong theo so tien va noi dung chuyen khoan.
- Cong nhan dang nhap bang so dien thoai va co the doi mat khau sau khi dang nhap.
- Sau 5 ngay cua thang ke tiep, neu cong no chua thanh toan thi he thong nhac Telegram va khoa quyen dang ky com; khi thanh toan thanh cong se mo lai.

## Cau hinh thanh toan

Sua file `data/db.json`, muc `settings.payment`:

```json
{
  "bankBin": "970436",
  "accountNo": "0123456789",
  "accountName": "CONG TY ABC",
  "template": "compact2"
}
```

`bankBin` la ma ngan hang theo VietQR/Napas.

## Cau hinh Telegram

Sua bien moi truong truoc khi chay server:

```powershell
$env:TELEGRAM_BOT_TOKEN="bot_token_cua_anh"
node server.js
```

Trong danh sach user, moi cong nhan can co `telegramChatId`.

## Mau file Excel/CSV nhap cong nhan

Trong Excel, tao cac cot sau roi Save As CSV:

```csv
phone,employeeCode,fullName,department
0901000001,CN001,Nguyen Van A,May 1
0901000002,CN002,Tran Thi B,May 2
```

## Mau CSV sao ke

File CSV can co cot:

```csv
date,amount,description
2026-07-01,625000,0901000001 COM T06-2026
2026-07-01,750000,0901000002 COM T06-2026
```

Doi soat se khop theo:

- So tien dung bang cong no thang.
- Noi dung co chua ma chuyen khoan theo so dien thoai: `0901000001 COM T06-2026`.
