# zalo-digest

Ghi lại tin nhắn từ các nhóm Zalo đã chọn và gửi báo cáo tóm tắt mỗi sáng vào **Cloud của tôi**.

> ⚠️ Dùng thư viện không chính thức `zca-js` (giả lập Zalo Web). Việc này vi phạm điều khoản của Zalo, nên **tài khoản có thể bị khóa**. Bạn tự chịu rủi ro.

Giai đoạn 1 (bản hiện tại): listener, lưu SQLite, báo cáo sáng.
Các giai đoạn sau: trích xuất task và nhắc deadline → tổng hợp số liệu → MCP server.

## Cài đặt trên VPS

Yêu cầu Node.js >= 22.13 (dùng `node:sqlite` có sẵn, không cần build native).

```bash
npm ci
cp .env.example .env    # điền ANTHROPIC_API_KEY
npm run groups          # lần đầu: quét QR ở data/qr.png bằng app Zalo, rồi in danh sách nhóm kèm ID
# chép ID nhóm cần theo dõi vào TRACKED_GROUP_IDS trong .env

npm i -g pm2
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
pm2 logs zalo-digest
```

Để lấy file QR từ VPS về máy: `scp vps:zalo-digest/data/qr.png .`. QR hết hạn sau khoảng 1 phút, sau đó tool tự tạo mã mới.

## Lệnh

| Lệnh | Tác dụng |
|---|---|
| `npm start` | Chạy listener và lịch báo cáo (dùng qua pm2) |
| `npm run groups` | Liệt kê nhóm kèm ID |
| `npm run report` | Tạo báo cáo ngay và in ra màn hình, không gửi |
| `npm run report -- --send` | Tạo báo cáo và gửi vào Cloud của tôi |

## Lưu ý vận hành

- **Đừng mở Zalo Web trên trình duyệt.** Mỗi tài khoản chỉ có một kết nối web listener; mở Zalo Web sẽ ngắt listener. Dùng app điện thoại bình thường. Zalo PC thì cần thử thực tế.
- Khi mất kết nối, process sẽ gửi email cảnh báo (nếu đã cấu hình `SMTP_URL`) rồi thoát để pm2 khởi động lại. Nếu cookie hết hạn, cần quét lại QR.
- Chỉ ghi lại tin nhắn **từ lúc listener bắt đầu chạy**; không lấy lịch sử cũ.
- Báo cáo bao gồm tin từ lần báo cáo trước tới hiện tại, lần đầu là 24h. Nếu gửi thất bại, lần sau sẽ gộp luôn phần bị lỡ.
- `data/credentials.json` chứa cookie đăng nhập Zalo, tương đương mật khẩu. Không commit, không chia sẻ.
- Nội dung tin nhắn của các nhóm được lưu trên VPS và gửi tới Claude API để tóm tắt.
