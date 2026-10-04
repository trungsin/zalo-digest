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

Mỗi tài khoản web gắn cố định với một Zalo UID trong `accounts.zalo_uid` (unique).
Worker phải được portal xác minh UID trước khi lưu cookie mới, thu tin hay mở MCP.
ID tài khoản, tên hiển thị, token và đường dẫn dữ liệu của worker được portal cấp;
`.env` của người dùng không thể đổi chúng hoặc tắt phạm vi nhóm MCP.
`data/account.json` giữ UID của thư mục dữ liệu, dùng cả cho triển khai thủ công.
Đăng nhập Zalo khác bị từ chối và không ghi đè cookie cũ. Không tự đổi UID hay xóa
dữ liệu khi reconnect. Muốn dùng một Zalo khác, tạo tài khoản web mới và kết nối mới.

Với tài khoản cũ chưa có UID, lần đăng nhập hợp lệ đầu tiên sau nâng cấp sẽ gắn UID.
Đây không phải kiểm chứng chủ sở hữu của dữ liệu đã lưu trước nâng cấp.
Không quét cùng Zalo trên portal và một dịch vụ thủ công đang chạy; đăng nhập
trùng có thể ngắt phiên cũ, kể cả khi portal từ chối kết nối trùng sau đó.

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
Người nhận Cloud được lấy từ `loginInfo.send2me_id`, khác ID tài khoản Zalo.
Lần gọi chỉ báo thành công sau khi API Zalo trả ID tin nhắn cho mọi phần nội dung.
Tool `zalo_get_account` trả tên tài khoản và UID cho đúng kết nối; tên MCP server
cũng chứa tên tài khoản. Mọi kết quả dữ liệu đều kèm danh tính. Client không có
tham số chọn tài khoản, đổi token, đổi thư mục hay đổi người nhận Cloud.
Khi worker lỗi, port bị thu hồi ngay; reconnect chờ worker cũ dừng và bỏ qua
mọi thông báo đến muộn. Đổi nhóm tạm ngừng MCP cho tới khi worker xác nhận xong.
Để thu hồi quyền MCP của một tài khoản: dừng portal, đổi token trong portal.db
bằng token ngẫu nhiên 32 byte, rồi khởi động lại. Token portal.db là nguồn cấp
quyền; worker không lấy token từ `.env`. Bản sao trong `.env` sẽ được cập nhật
khi lưu lại nhóm.
Nếu thay hostname, sửa `PORTAL_ORIGIN` và restart; URL MCP hiển thị sẽ theo host mới.

Kiểm tra HTTP và phạm vi MCP:
`node --import tsx --test tests/*.test.ts`.

Bộ kiểm tra nhiều người dùng chạy ba worker và MCP thật với ba SQLite riêng;
chỉ API mạng Zalo được giả lập. Các ca kiểm tra dùng cùng group ID/task ID giữa
các tài khoản, đọc/sửa/gửi đồng thời, token không hợp lệ, header token khác tài khoản,
ghi đè cấu hình, đăng nhập trùng, đổi Zalo khi reconnect, thông báo worker cũ và
phản hồi web đến muộn sau khi đăng xuất/chuyển tài khoản. Không thay thế thử tải
với nhiều phiên Zalo thực tế; portal hiện giới hạn 20 tài khoản web.
