# Facebook Comment Telegram Bot

Bot Telegram chạy độc lập bằng Docker, tương thích Linux/Armbian/ARM64, để:

1. nhận lệnh qua Telegram,
2. lưu/cập nhật Facebook cookies,
3. lưu/cập nhật Facebook Graph/Ads token,
4. check cookies + token còn sống không,
5. lấy toàn bộ comment + reply của 1 bài viết/reel/video/live Facebook,
6. xuất 1 Google Sheet gồm 2 tab:
   - `tat_ca_cmt`: tất cả bình luận,
   - `tat_ca_tuong_tac`: tất cả user có tương tác/comment, xếp cao xuống thấp.
   - nếu Telegram yêu cầu `top N`, bot thêm tab riêng `top_N_tuong_tac`.

Bot dùng Node.js native `fetch`, không cần npm package ngoài.

## 1. File cấu trúc

```text
facebook-comment-telegram-bot/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── .env.example
├── src/
│   ├── bot.js
│   ├── config.js
│   ├── facebook.js
│   ├── sheets.js
│   ├── storage.js
│   ├── telegram.js
│   └── workbook.js
├── data/     # lưu cookie/token, không commit public
└── state/    # lưu kết quả crawl/checkpoint
```

## 2. Cài Docker trên Armbian/Linux

Nếu máy chưa có Docker:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

Nếu dùng Docker Compose plugin chưa có:

```bash
sudo apt-get update
sudo apt-get install -y docker-compose-plugin
```

Kiểm tra:

```bash
docker version
docker compose version
```

## 3. Setup bot

Vào thư mục project:

```bash
cd facebook-comment-telegram-bot
cp .env.example .env
nano .env
```

Điền các biến:

```env
TELEGRAM_BOT_TOKEN=token_bot_telegram_tu_BotFather
AUTHORIZED_USER_ID=telegram_user_id_cua_ban
SHEETS_WEBHOOK_URL=url_apps_script_webhook
SHEETS_SECRET_TOKEN=secret_apps_script
SHEETS_FOLDER_ID=google_drive_folder_id_muon_luu_sheet
FB_API_VERSION=v25.0
DEFAULT_LIMIT=200
DEFAULT_DELAY_MS=600
EXPORT_CHUNK_SIZE=1000
EXPORT_DELAY_MS=600
```

Ghi chú:

- `TELEGRAM_BOT_TOKEN`: lấy từ `@BotFather`.
- `AUTHORIZED_USER_ID`: Telegram user ID được phép dùng bot. Có thể lấy bằng `@userinfobot`. Để trống thì ai nhắn bot cũng dùng được, không khuyến nghị.
- `SHEETS_WEBHOOK_URL` + `SHEETS_SECRET_TOKEN`: Apps Script webhook để tạo/ghi/format Google Sheet.
- `SHEETS_FOLDER_ID`: ID thư mục Google Drive muốn lưu Sheet vào. Lấy từ URL folder, ví dụ `https://drive.google.com/drive/folders/1abc...xyz` thì folder id là `1abc...xyz`.

## 4. Chạy Docker

Build và chạy nền (lần đầu):

```bash
docker compose up -d --build
```

Khi có bản cập nhật code mới, kéo code về và build lại:

```bash
git pull
docker compose up -d --build
```

Xem log:

```bash
docker compose logs -f
```

Restart:

```bash
docker compose restart
```

Dừng:

```bash
docker compose down
```

## 5. Lệnh Telegram

### Help

```text
/start
fb help
```

### Kiểm tra file đang có

```text
fb status
```

Lệnh này chỉ kiểm tra đã lưu cookie/token/webhook chưa, không gọi Facebook.

### Check cookies + token còn sống

```text
fb check
```

Hoặc:

```text
checklive
fb check cookie
```

Bot sẽ gọi Graph API `/me` bằng token + cookies đang lưu. Nếu OK sẽ trả về account Facebook. Nếu lỗi sẽ báo cần update lại.

### Lưu/update cookies

Có thể gửi:

```text
update_cookies
```

Sau đó gửi file cookie JSON hoặc dán cookie header text dạng:

```text
sb=...; datr=...; c_user=...; xs=...; fr=...
```

Hoặc gửi 1 dòng:

```text
update_cookies sb=...; datr=...; c_user=...; xs=...; fr=...
```

Alias hỗ trợ:

```text
fb lưu cookie
fb save cookies
fb update cookies
```

Cookie bắt buộc có `c_user` và `xs`. Bot lưu vào:

```text
./data/facebook_cookie.json
```

### Lưu/update token

```text
update_token EAAB...
```

Hoặc:

```text
update_token
```

rồi gửi token ở tin nhắn kế tiếp.

Alias hỗ trợ:

```text
fb lưu token EAAB...
fb update token EAAB...
```

Bot chỉ trả prefix + độ dài, không in full token. Token lưu ở:

```text
./data/facebook_token.txt
```

### Lấy comment và xuất Google Sheet

Flow tuần tự:

```text
get_cmt
```

Bot sẽ tự kiểm tra thiếu gì:

1. thiếu cookies → yêu cầu gửi cookies,
2. thiếu token → yêu cầu gửi token,
3. đủ rồi → yêu cầu gửi URL bài viết,
4. crawl comment/reply,
5. tạo Google Sheet và gửi link lại Telegram.

Gửi nhanh khi đã đủ cookies + token:

```text
get_cmt https://www.facebook.com/xxx/posts/123456789
```

Nếu muốn thêm tab top riêng ngoài 2 tab mặc định:

```text
get_cmt https://www.facebook.com/xxx/posts/123456789 top 20
```

Hoặc:

```text
fb lấy cmt https://www.facebook.com/xxx/posts/123456789 lấy top 50
```

Alias hỗ trợ:

```text
fb get_cmt <URL>
fb lấy cmt <URL>
fb export <URL>
fb lấy comment <URL>
```

## 6. Google Sheet output

Bot tạo 1 spreadsheet, gồm 2 tab.

### Tab `tat_ca_cmt`

Cột:

```text
Thời gian | Tên FB | ID | Nội dung | ID_Comment | Link_Comment | Link_Profile
```

### Tab `tat_ca_tuong_tac`

Cột:

```text
Tên FB | Điểm TT | Link_Profile
```

`Điểm TT` = tổng số comment/reply của user trong bài viết. Chủ bài/page được loại khỏi bảng tương tác nếu Graph API lấy được owner id.

Nếu lệnh Telegram có `top N`, ví dụ `get_cmt <URL> top 20`, bot tạo thêm tab `top_20_tuong_tac` với cùng cột nhưng chỉ lấy N user đầu tiên.

## 7. Dữ liệu lưu ở đâu?

Secrets:

```text
./data/facebook_cookie.json
./data/facebook_token.txt
```

Kết quả:

```text
./state/comments_<POST_ID>.json
./state/comments_<POST_ID>.checkpoint.json
./state/comments_<POST_ID>_workbook.json
./state/comments_<POST_ID>_summary.json
```

## 8. Apps Script webhook format

Bot gửi request dạng:

```json
{
  "secret": "...",
  "action": "create|append|format",
  "title": "Spreadsheet title",
  "folderId": "optional_google_drive_folder_id",
  "spreadsheetId": "...",
  "sheetName": "tat_ca_cmt",
  "headers": ["..."],
  "rows": [{ "col": "value" }]
}
```

Webhook cần trả:

```json
{ "ok": true, "spreadsheetId": "...", "url": "..." }
```

cho action `create`, hoặc:

```json
{ "ok": true, "totalRows": 123 }
```

cho action `append` / `format`.

## 9. Lưu ý

- Cookie và token nên cùng 1 Facebook account/session.
- Cookie/token có thể hết hạn; dùng `fb check` để kiểm tra nhanh.
- Facebook có rate limit. Nếu gặp lỗi limit, tăng `DEFAULT_DELAY_MS` lên `1000-2000` trong `.env` rồi restart.
- Không commit `.env`, `data/`, `state/` lên Git public.
