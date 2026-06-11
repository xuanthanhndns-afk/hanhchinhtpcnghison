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
- Admin quan ly danh sach dau bep gom ho ten va so dien thoai.
- Admin co the dat lai mat khau thanh vien ve `123456`; thanh vien bat buoc doi mat khau khi dang nhap lai.
- Nha bep nhap/sua dinh luong tung mon an theo bua bang cac o co san: so thu tu, ten mon, dinh luong gam, don gia/gam. He thong tu tinh thanh tien tung mon va tong gia tien moi suat.
- Khi nhap dinh luong suat an, co the chon mot hoac nhieu dau bep thuc hien bua an.
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

## Mau file Excel nhap thanh vien

Co file mau trong thu muc `templates`:

- `templates/Mau_nhap_danh_sach_cong_nhan.xlsx`
- `templates/Mau_nhap_danh_sach_cong_nhan.csv`

Admin co the chon truc tiep file `.xlsx` theo mau de nhap danh sach. He thong se tu dung so dien thoai lam tai khoan dang nhap va mat khau mac dinh la `123456`:

```csv
So thu tu,Ho va ten,Bo phan,So dien thoai
1,Nguyen Van A,May 1,0901000001
2,Tran Thi B,May 2,0901000002
```

## Luu y luu tru du lieu khi dua len Render

He thong co the luu du lieu vao file theo bien moi truong `DATA_FILE`. Khi chay local, neu khong cau hinh bien nay thi he thong dung file mau `data/db.json`.

Khi dua len Render, can gan Persistent Disk de du lieu khong mat sau moi lan deploy/restart:

1. Vao Render service `hanhchinhtpcnghison`.
2. Vao muc `Disks`, tao disk moi.
3. Chon mount path: `/var/data`.
4. Trong `Environment`, dam bao co bien:

```text
DATA_FILE=/var/data/db.json
```

File `render.yaml` da khai bao san bien `DATA_FILE=/var/data/db.json`. Neu khong gan Persistent Disk tai `/var/data`, file van co the bi mat khi Render redeploy/restart.

Luu y: Render Persistent Disk chi gan duoc cho web service tra phi. Neu tiep tuc dung plan `free`, nen chuyen sang co so du lieu ben ngoai nhu PostgreSQL de tranh mat du lieu khi deploy.

Voi nhu cau van hanh lau dai, nen chuyen sang PostgreSQL hoac gan Persistent Disk de luu du lieu ben vung.

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
