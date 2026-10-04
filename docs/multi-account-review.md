# Rà soát triển khai nhiều tài khoản — 2026-10-04

Phạm vi: đăng nhập portal, cookie web/Zalo, thư mục dữ liệu, worker, token và
HTTP proxy MCP; các tool đọc tin, việc, số liệu, cập nhật việc và gửi Cloud;
reconnect, đổi nhóm, giao diện chuyển tài khoản và MCP stdio/triển khai thủ công.

## Các điểm đã sửa

| Mức độ | Vấn đề | Bản sửa |
|---|---|---|
| Cao | Đăng nhập Zalo khác vào cùng tài khoản web có thể dùng chung dữ liệu/token cũ | Gắn UID cố định ở portal.db và account.json; xác minh trước khi lưu cookie, thu tin hoặc mở MCP |
| Cao | Hai tài khoản web có thể kết nối cùng Zalo | Unique Zalo UID, portal từ chối đăng nhập trùng |
| Cao | Cấu hình DATA_DIR/token/phạm vi của worker có thể bị ghi đè từ .env | Thư mục, token, danh tính và phạm vi portal được lấy từ cấu hình cha và giữ cố định |
| Vừa | Worker lỗi còn giữ port/tiến trình; thông báo cũ có thể làm sai trạng thái reconnect | Thu hồi port ngay, chờ tiến trình cũ thoát, kiểm tra worker hiện hành trước khi nhận IPC, thoát khi mất portal |
| Vừa | MCP không cho ứng dụng AI biết đang dùng Zalo nào | Tool zalo_get_account, tên server có tên người dùng, mọi kết quả thành công kèm tên và UID |
| Vừa | Phản hồi status đến muộn sau logout/chuyển tài khoản có thể hiện URL MCP cũ | Bỏ phản hồi thuộc phiên giao diện cũ |
| Vừa | MCP stdio thiếu USER_DIR có thể tự mở dữ liệu thư mục mặc định | Bắt buộc chọn USER_DIR trước khi import cấu hình/database |

## Quy tắc khi chạy

Một token portal → một tài khoản web → một Zalo UID → một worker → một SQLite
và một Cloud của tài khoản đó. Lời gọi tool không có quyền đổi tài khoản hoặc
người nhận. Proxy chọn worker theo token trong URL và cấp lại đúng token nội bộ;
header của client không đổi tài khoản đích. Khi worker lỗi, trả lỗi thay vì chọn
worker của người khác. Các nhóm chưa chọn không được đọc/cập nhật qua MCP.

Triển khai thủ công cần USER_DIR, token và port riêng cho từng người. account.json
chặn đổi Zalo trong cùng thư mục, nhưng không phải cơ chế khóa phiên toàn máy:
quản trị viên vẫn phải tránh chạy cùng Zalo ở portal và dịch vụ thủ công.
SSH hoặc quyền hệ điều hành của chủ VPS có thể đọc mọi thư mục; cách ly ở đây
là giữa các người dùng web/MCP, không phải giữa quản trị viên máy chủ.

## Kiểm tra và giới hạn

Typecheck và bộ kiểm tra bao gồm ba tài khoản cùng hoạt động, dùng cùng group ID,
cùng task ID nhưng nội dung khác nhau. Kiểm tra đọc tin/việc/số liệu, sửa việc,
gửi Cloud đồng thời, token sai, header token tài khoản khác, ghi đè cấu hình,
đổi nhóm, đăng nhập trùng, đổi Zalo khi reconnect, thông báo IPC đến muộn,
không ghi đè cookie khi xác minh thất bại và trạng thái web đến muộn.

Các worker, HTTP MCP và SQLite trong kiểm tra là thật; chỉ kết nối mạng Zalo được
giả lập. Portal hiện giới hạn 20 tài khoản, chưa có thử tải 20 phiên Zalo thật.
Tài khoản đã tồn tại được gắn UID từ lần đăng nhập hợp lệ đầu tiên sau nâng cấp;
không thể xác minh hồi tố chủ sở hữu của từng tin đã lưu trước khi có binding.
