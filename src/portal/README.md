# Trang tự kết nối Zalo

Chạy `npm run portal` với `PORTAL_INVITE_CODE` (ít nhất 16 ký tự),
`PORTAL_ORIGIN` (URL HTTPS công khai), `PORTAL_PORT` (mặc định 3080).
Server chỉ nghe trên loopback. Tuyến Cloudflare Tunnel cho hostname phải chuyển
toàn bộ đường dẫn tới `http://127.0.0.1:3080`.

Người dùng tạo tài khoản bằng mã mời, đồng ý kết nối Zalo, quét QR, chọn nhóm,
rồi sao chép URL MCP. Các lần đăng nhập sau dùng tên tài khoản và mật khẩu web.
Phiên web có hạn 7 ngày. Đăng xuất web không dừng thu tin; dịch vụ tiếp tục thu
cho các nhóm đã chọn. Khi mất phiên Zalo, người dùng bấm kết nối lại.

`portal-data/portal.db` chứa tài khoản web, hash mật khẩu scrypt, hash phiên web
và token MCP. Mỗi tài khoản có tiến trình, `.env`, cookie Zalo và SQLite riêng
trong `portal-data/users/<uuid>/`. Sao lưu toàn bộ `portal-data` khi dịch vụ dừng.
Thư mục này và `.portal.env` đã được bỏ qua bởi Git.

Bản portal này thu tin cho MCP, không gọi model để tự tạo báo cáo, trích việc
hay số liệu. Người dùng đọc/tóm tắt bằng ứng dụng MCP của họ. MCP giữ các tool
hiện có; việc/số liệu sẽ trống nếu chưa được trích. Đổi nhóm theo dõi không xóa
dữ liệu cũ, nhưng MCP chỉ đọc các nhóm đang chọn.

Triển khai systemd bằng `deploy/zalo-portal.service` và `.portal.env` mode 600.
Không chuyển tài khoản `users/leesun` đang chạy sang portal; tránh hai listener
cùng đăng nhập một tài khoản Zalo. Tối đa 20 tài khoản được tạo bằng mã mời.
Đổi mã mời bằng cách sửa `.portal.env` và restart dịch vụ.

Không bật log URL MCP trên reverse proxy: URL chứa token cá nhân.
MCP có tool `zalo_send_to_self` gửi văn bản vào Cloud của tôi của chính tài khoản
đang kết nối, dùng lại phiên Zalo của worker; tối đa 10.000 ký tự mỗi lần gọi.
Để thu hồi quyền MCP của một tài khoản: dừng portal, đổi token trong portal.db
và trong `.env` tương ứng bằng cùng token ngẫu nhiên 32 byte, rồi khởi động lại.
Nếu thay hostname, sửa `PORTAL_ORIGIN` và restart; URL MCP hiển thị sẽ theo host mới.

Kiểm tra HTTP và phạm vi MCP:
`node --import tsx --test tests/portal.test.ts tests/mcp-scope.test.ts`.
