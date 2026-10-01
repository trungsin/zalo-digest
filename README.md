# zalo-digest

Ghi lại tin nhắn từ các nhóm Zalo đã chọn và gửi báo cáo tóm tắt mỗi sáng vào **Cloud của tôi**. Một VPS chạy được cho nhiều người, mỗi người có cấu hình riêng.

> ⚠️ Dùng thư viện không chính thức `zca-js` (giả lập Zalo Web). Việc này vi phạm điều khoản của Zalo, nên **tài khoản có thể bị khóa**. Người dùng phải được báo trước và đồng ý.

Đã có: listener, lưu SQLite, báo cáo sáng cá nhân hóa, chạy cho nhiều người (giai đoạn 1); trích việc và nhắc deadline (giai đoạn 2); tổng hợp số liệu (giai đoạn 3).
Sắp làm: MCP server.

## Số liệu

Số liệu được trích **cùng lượt** với việc trích task, nên không tốn thêm request tới model.

- **Model chỉ trích số:** chỉ số (tên chuẩn, tái dùng tên đã có trong nhóm), người báo cáo, giá trị, đơn vị (tiền quy về triệu đồng) và ngày mà số liệu thuộc về. Nếu ai đó đính chính ("em nhầm, DS 130tr") thì số mới ghi đè số cũ.
- **Phép tính do code làm:** tổng (ưu tiên số "Tổng" do người trong nhóm báo, nếu có), so với kỳ trước, và lũy kế tháng. Chỉ số không cộng dồn được (%, tồn kho...) thì chỉ hiển thị, không cộng.
- **Báo cáo sáng** có mục SỐ LIỆU, ví dụ:
  ```
  doanh số (triệu đồng) · 02/10: Lan 120 · Minh 95 → tổng 215 (01/10: 180, +19%) · lũy kế T10: 395
  ```
- **Lệnh trong Cloud:** gõ `solieu` để xem lũy kế tháng theo từng người.
- **Xuất CSV:** `USER_DIR=users/<tên> npm run export-metrics` tạo file `data/metrics.csv`, mở được bằng Excel, có kèm tin gốc để đối chiếu.
- `METRIC_HINTS` trong `.env` dùng để khai báo cách viết tắt riêng của nhóm.

Đây là số do model đọc từ tin nhắn tự do, có thể sai. Khi cần dùng số chính thức, hãy đối chiếu với cột "tin gốc" trong file CSV.

## Việc & nhắc deadline

- **Trích việc:** mặc định mỗi 2 giờ từ 7h đến 21h, model đọc tin mới và lưu các việc liên quan đến bạn:
  - **việc của bạn:** được giao, hoặc bạn nhận làm.
  - **việc bạn đang chờ:** bạn giao cho người khác, hoặc người khác hứa làm cho bạn.

  Nếu chat cho thấy một việc đã xong, bị hủy hoặc đổi hạn, việc đó được cập nhật luôn. Chỉ gọi model khi có tin mới.
- **Nhắc việc:** mỗi 15 phút kiểm tra việc sắp đến hạn (mặc định trước 2 tiếng) rồi gom vào một tin trong Cloud của tôi. Mỗi việc chỉ nhắc một lần, tối đa 5 tin/ngày, không nhắc từ 22h đến 7h.
- **Báo cáo sáng** có thêm danh sách việc quá hạn, việc hôm nay, việc 7 ngày tới, việc chưa có hạn, và việc đang chờ người khác.
- **Lệnh trong Cloud của tôi:**

  | Gõ | Tác dụng |
  |---|---|
  | `viec` | Xem danh sách việc đang mở |
  | `xong 3` hoặc `xong 3 5` | Đánh dấu việc đã xong |
  | `huy 3` | Hủy việc |
  | `solieu` | Số liệu lũy kế tháng |

Model có thể bắt sai hoặc bỏ sót việc. Các việc được trích ra chỉ để tham khảo, không thay được việc bạn tự đọc tin.

## Cài đặt trên VPS

Yêu cầu Node.js >= 22.13 (dùng `node:sqlite` có sẵn, không cần build native).

```bash
npm ci
npm i -g pm2
```

## Thêm một người

```bash
npm run add-user -- an                 # tạo users/an/.env từ mẫu
nano users/an/.env                     # điền API key, USER_PROFILE
USER_DIR=users/an npm run groups       # người đó quét QR ở users/an/data/qr.png, rồi in danh sách nhóm
nano users/an/.env                     # điền TRACKED_GROUP_IDS
pm2 start ecosystem.config.cjs --only zalo-an && pm2 save
```

Lần đầu cài thêm `pm2 startup` để tự chạy lại khi VPS khởi động. `ecosystem.config.cjs` tự tạo một process `zalo-<tên>` cho mỗi thư mục `users/<tên>/` có file `.env`.

Để lấy file QR về máy: `scp vps:zalo-digest/users/an/data/qr.png .`, rồi gửi cho người đó quét. QR hết hạn sau khoảng 1 phút, sau đó tool tự tạo mã mới.

## Cá nhân hóa (trong `users/<tên>/.env`)

| Biến | Ý nghĩa |
|---|---|
| `USER_PROFILE` | Người đó là ai và quan tâm gì. Báo cáo sẽ ưu tiên theo đây |
| `REPORT_STYLE` | `short` (mặc định) hoặc `detailed` |
| `REPORT_CRON` | Giờ gửi báo cáo, mặc định `0 8 * * *` |
| `TRACKED_GROUP_IDS` | Các nhóm cần theo dõi |
| `LLM_PROVIDER` | `gemini` (mặc định) hoặc `claude` |
| `LLM_MODEL` | Mặc định `gemini-flash-latest` / `claude-haiku-4-5` |

### Chọn model

- **Gemini free tier:** miễn phí, hạn mức dư cho vài báo cáo mỗi ngày. **Ở bản free, Google có thể dùng nội dung gửi lên (tức là tin nhắn trong group) để cải thiện sản phẩm.** Mỗi người nên tạo key riêng tại Google AI Studio.
- **Claude API:** khoảng 0,6 USD/người/tháng với Haiku. Dữ liệu không bị dùng để huấn luyện model.
- Gói sub Claude (Pro/Max) **không** dùng được làm backend cho bot (trái điều khoản).

## Lệnh

Mọi lệnh đều cần thêm `USER_DIR=users/<tên>` ở đầu để chọn người.

| Lệnh | Tác dụng |
|---|---|
| `npm run add-user -- <tên>` | Tạo cấu hình cho một người mới |
| `npm run groups` | Liệt kê nhóm kèm ID (đăng nhập QR nếu chưa có) |
| `npm run report` | Tạo báo cáo ngay và in ra màn hình, không gửi |
| `npm run report -- --send` | Tạo báo cáo và gửi vào Cloud của tôi |
| `npm run export-metrics` | Xuất số liệu ra CSV |

⚠️ Nên dừng process pm2 của người đó trước khi chạy `groups` hoặc `--send`. Hai phiên đăng nhập cùng lúc có thể làm Zalo ngắt phiên đang chạy (chưa kiểm chứng).

## Lưu ý vận hành

- **Đừng mở Zalo Web trên trình duyệt.** Mở Zalo Web sẽ ngắt listener. App điện thoại thì không sao. Zalo PC cần thử thực tế.
- Khi mất kết nối, process gửi email cảnh báo (nếu đã cấu hình `SMTP_URL`) rồi thoát để pm2 khởi động lại. Nếu cookie hết hạn, cần quét lại QR.
- Chỉ ghi lại tin nhắn **từ lúc listener bắt đầu chạy**; không lấy lịch sử cũ.
- Báo cáo bao gồm tin từ lần báo cáo trước tới hiện tại, lần đầu là 24h. Nếu gửi thất bại, lần sau sẽ gộp luôn phần bị lỡ.
- `users/<tên>/data/credentials.json` là cookie Zalo của người đó, tương đương mật khẩu. Hạn chế người có quyền vào VPS; không commit thư mục `users/`.
