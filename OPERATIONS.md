# Vận hành trên máy leesun

Ứng dụng nằm tại `/home/leesun/zalo-digest`, Node.js 22.22.1. Dịch vụ dùng systemd: `zalo-digest@leesun`. Không chạy thêm PM2 cho cùng tài khoản.

## Kích hoạt lần đầu

```bash
cd /home/leesun/zalo-digest
nano users/leesun/.env
```

Điền `GEMINI_API_KEY`, sửa `USER_PROFILE` theo nhu cầu. Nếu dùng Claude API: đặt `LLM_PROVIDER=claude` và `ANTHROPIC_API_KEY`. Gói thuê bao Claude không thay cho API key.

Đăng nhập và lấy nhóm:

```bash
USER_DIR=users/leesun npm run groups
```

Mở `users/leesun/data/qr.png`, quét bằng Zalo điện thoại rồi xác nhận. QR tự đổi khi hết hạn; mở lại file để xem mã mới. Lệnh sẽ in tên và ID nhóm sau khi đăng nhập. Điền các ID muốn theo dõi vào `.env`:

```dotenv
TRACKED_GROUP_IDS=123456789,987654321
REPORT_CRON=0 8 * * *
TZ_REPORT=Asia/Ho_Chi_Minh
```

Kiểm tra rồi bật dịch vụ:

```bash
USER_DIR=users/leesun npm run check-config
sudo systemctl enable --now zalo-digest@leesun
sudo systemctl status zalo-digest@leesun --no-pager
sudo journalctl -u zalo-digest@leesun -n 50 --no-pager
```

`check-config` kiểm tra cấu hình và sự tồn tại của cookie; không xác minh API key hay phiên Zalo qua mạng. Log thành công có `logged in as`, `tracking ... group(s)` và `Report scheduled`.

Bot chỉ thu tin từ lúc chạy, không tải lịch sử cũ. Báo cáo mặc định gửi vào **Cloud của tôi** lúc 08:00 Việt Nam. Chờ nhóm có tin mới rồi thử tạo báo cáo để xác minh API key.

## Điều khiển thường ngày

```bash
sudo systemctl status zalo-digest@leesun --no-pager
sudo journalctl -u zalo-digest@leesun -f
sudo systemctl restart zalo-digest@leesun
sudo systemctl stop zalo-digest@leesun
sudo systemctl start zalo-digest@leesun
```

`Ctrl+C` thoát màn hình log, không dừng bot. Sửa `.env` xong cần restart. Dịch vụ tự restart sau 60 giây nếu process lỗi. `disable --now` tắt dịch vụ và bỏ tự chạy khi reboot.

Tạo báo cáo thử, chỉ in ra màn hình:

```bash
cd /home/leesun/zalo-digest
USER_DIR=users/leesun npm run report
USER_DIR=users/leesun npm run export-metrics
```

CSV nằm tại `users/leesun/data/metrics.csv`. Khi muốn gửi báo cáo thử, dừng listener để tránh hai phiên đăng nhập cùng lúc:

```bash
sudo systemctl stop zalo-digest@leesun
USER_DIR=users/leesun npm run report -- --send
sudo systemctl start zalo-digest@leesun
```

Nhớ chạy lại lệnh `start` kể cả khi gửi báo cáo lỗi. Báo cáo gửi thành công sẽ cập nhật mốc dữ liệu của báo cáo tiếp theo.

Trong Cloud của tôi: `viec` xem việc, `xong 3` đánh dấu xong, `huy 3` hủy, `solieu` xem số liệu tháng.

## Mất phiên hoặc cần chọn lại nhóm

Dừng dịch vụ, chạy `groups`, quét QR nếu được yêu cầu, cập nhật ID rồi chạy lại:

```bash
sudo systemctl stop zalo-digest@leesun
cd /home/leesun/zalo-digest
USER_DIR=users/leesun npm run groups
nano users/leesun/.env
USER_DIR=users/leesun npm run check-config
sudo systemctl start zalo-digest@leesun
```

Tránh mở Zalo Web khi bot chạy vì có thể làm mất phiên. Nếu log báo API key/quota, kiểm tra key và hạn mức của nhà cung cấp. Có thể cấu hình `SMTP_URL` và `ALERT_EMAIL` để nhận cảnh báo lỗi.

## Sao lưu và cập nhật

Sao lưu cả cấu hình, cookie và SQLite; dừng dịch vụ lúc sao lưu để giữ DB nhất quán:

```bash
cd /home/leesun/zalo-digest
mkdir -p backups
chmod 700 backups
sudo systemctl stop zalo-digest@leesun
tar -czf "backups/leesun-$(date +%Y%m%d-%H%M%S).tar.gz" users/leesun
chmod 600 backups/*.tar.gz
sudo systemctl start zalo-digest@leesun
```

Đưa bản sao sang nơi lưu trữ riêng có bảo vệ. Cookie và API key trong bản sao cần được giữ kín. Khôi phục khi dịch vụ đã dừng, giải nén bản sao từ thư mục repo rồi start lại.

Khi cập nhật, giữ bản sao dữ liệu và kiểm tra `git status` trước. Máy này có thay đổi cục bộ phục vụ triển khai; cần giữ các thay đổi đó trước khi pull. Sau khi cập nhật code:

```bash
npm ci --include=dev
npm run typecheck
USER_DIR=users/leesun npm run check-config
sudo systemctl restart zalo-digest@leesun
```

## MCP và nhiều người dùng

### Website tự đăng nhập

Trang đã triển khai tại `https://zalo.datxanhmientrung.ai`, dịch vụ
`zalo-portal.service`, port loopback 3080. Người dùng tạo tài khoản bằng mã mời,
quét QR, chọn nhóm và lấy URL MCP riêng. Mã mời nằm trong `.portal.env` (không
commit hoặc gửi file này cho người dùng). Có thể gửi riêng giá trị mã mời.

`sudo systemctl status zalo-portal --no-pager` để kiểm tra;
`sudo systemctl restart zalo-portal` sau khi cập nhật code/cấu hình.
Cookie Zalo và database người dùng portal nằm trong `portal-data/`;
sao lưu toàn bộ thư mục này khi dịch vụ dừng. Portal không dùng API key model:
nó thu tin cho MCP, chưa tự trích việc/số liệu hoặc gửi báo cáo.
Xem [hướng dẫn portal](src/portal/README.md) để vận hành.

Tài khoản `leesun` hiện tại vẫn chạy bằng dịch vụ cũ. Không quét cùng tài khoản
Zalo đó trên portal khi listener cũ còn chạy.

### MCP cho tài khoản triển khai thủ công

MCP chưa bật mặc định. Nếu cần: thêm `MCP_TOKEN` ngẫu nhiên tối thiểu 32 ký tự, `MCP_PORT=3101` vào `.env`, restart. Server nghe trên `127.0.0.1`; muốn truy cập ngoài máy cần cấu hình hostname/path trong tunnel hiện có. Không cài lại cloudflared vì máy đã có dịch vụ đang chạy. Xem README để cấu hình tuyến `/leesun/` tới `http://localhost:3101`; kiểm tra request không token nhận 401.

Thêm người: `npm run add-user -- ten`, hoàn thành các bước cấu hình/QR/nhóm tương tự, rồi dùng `sudo systemctl enable --now zalo-digest@ten`. Mỗi người bật MCP cần một port riêng.

Repo sử dụng thư viện Zalo không chính thức, có rủi ro tài khoản bị hạn chế. Dữ liệu nhóm được gửi đến nhà cung cấp model để tóm tắt/trích việc. Cookie trong `users/leesun/data/credentials.json` tương đương thông tin đăng nhập; không chia sẻ hoặc commit thư mục `users/`.
