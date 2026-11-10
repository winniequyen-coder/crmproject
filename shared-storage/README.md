# CRM Project Control Dashboard — GitHub Shared Storage Preview

## Trạng thái hiện tại

- UI: `preview/v20-8/CRM_Project_Control_Dashboard_V20_8_Preview.html`
- Gateway: `preview/v20-8/shared-storage/worker.js`
- Data: `preview/dashboard-data-v20-8/data/project-data.json`
- Production `main/index.html` không thay đổi.
- **Chưa deploy Cloudflare Worker; không có GitHub Token hoặc tài khoản quản trị trong repository.** UI vẫn là bản xem dữ liệu mẫu và không cho phép lưu cho tới khi kết nối Gateway.
- Branch dữ liệu khác branch `main`, tránh kích hoạt GitHub Pages deployment mỗi lần Admin cập nhật tiến độ.

## Kiến trúc

`GitHub Pages (giao diện) → Cloudflare Worker + Access (xác thực Admin) → GitHub Contents API (file JSON trên nhánh dữ liệu riêng)`.

- `GET /state`: đọc JSON và GitHub blob SHA, không cache; mọi thiết bị nhận cùng nguồn dữ liệu.
- `GET /auth/start?origin=<origin>`: Cloudflare Access bảo vệ đường dẫn; Worker xác minh chữ ký JWT và danh sách email Admin, trả phiên đăng nhập ngắn hạn qua `postMessage`.
- `PUT /state`: yêu cầu Bearer token phiên Admin, `If-Match` là SHA mới nhất, kiểm tra schema và xung đột. Chỉ trả thành công sau khi GitHub ghi nhận SHA mới; lỗi 409 không ghi đè.
- GitHub Token chỉ nằm trong **Worker Secret**, không có trong JavaScript và không được lưu trong LocalStorage.
- Dữ liệu lịch sử lưu qua Git commit; có thể phục hồi theo Git, nhưng khôi phục cần quy trình phê duyệt và đối soát dữ liệu.

## Thiết lập hạ tầng — bắt buộc trước khi kích hoạt

1. Xác nhận dữ liệu trong repo **public** là phù hợp để công khai. Không đưa dữ liệu bệnh nhân, mật khẩu, token hoặc thông tin bảo mật vào kho public.
2. Tạo Cloudflare Worker trên tên miền do tổ chức kiểm soát (HTTPS), bảo vệ **chính xác route `/auth/start`** bằng Cloudflare Access self-hosted application. Không bảo vệ `/state` bằng browser-login vì trang Dashboard cần đọc công khai; chỉ PUT phải được Worker xác thực. Route `/auth/start` không được cấp quyền công khai.
3. Lấy `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` từ ứng dụng Cloudflare Access thực tế. Thiết lập `ADMIN_EMAILS` chỉ gồm những email được phép cập nhật tiến độ.
4. Tạo GitHub fine-grained Token giới hạn tại repository `winniequyen-coder/crmproject`, chỉ quyền **Contents: Read and write**; lưu token bằng `npx wrangler secret put GITHUB_TOKEN`, KHÔNG ghi vào `wrangler.toml` hoặc HTML. Tạo khóa ngẫu nhiên tối thiểu 32 ký tự và lưu với `npx wrangler secret put SESSION_SECRET`.
5. Vào thư mục `shared-storage`, cấu hình `wrangler.toml` các biến Access, Admin email, CORS. Cấu hình route/custom domain tại Cloudflare; triển khai Worker sau khi kiểm tra quyền.
6. Trong bản HTML **Preview** sửa hằng `const SHARED_API_URL=""` thành URL HTTPS Worker vừa triển khai. Không truyền GitHub Token hoặc mật khẩu vào HTML. Mở Dashboard bằng HTTPS với origin nằm trong `ALLOWED_ORIGINS`.
7. Test GET dữ liệu, đăng nhập Admin qua Access, cập nhật một Task ít rủi ro, refresh trang, đọc trên máy khác, so sánh SHA, kiểm thử xung đột 409. Xác nhận git history trên data branch, kiểm tra Production `main` không đổi.
8. Chỉ triển khai Production sau khi người dùng yêu cầu rõ, có phê duyệt nghiệp vụ và hoàn thành regression test.

## Chuyển đổi dữ liệu LocalStorage cũ

**Không tự động lấy LocalStorage làm nguồn dữ liệu trung tâm.** Trong bản V20.8 có thể có người đã cập nhật dữ liệu LocalStorage trên máy của họ, chưa nằm trong `project-data.json`. Trước khi chuyển Production:

- Xuất Excel hoặc bản sao có kiểm soát từ browser đang giữ dữ liệu đã duyệt.
- So sánh số Task, Task ID, Parent ID, tỷ lệ tiến độ, Baseline, Current/Actual, Cancel/Restore và các thay đổi thực tế với data branch.
- Phê duyệt snapshot khởi tạo; chỉ khi đó đưa snapshot lên GitHub data branch và cho phép Admin ghi trực tiếp.
- Không dùng mã nguồn nhúng cũ để ghi đè dữ liệu đang lưu trên GitHub.

## QA / Regression Test bắt buộc

| Test | Kết quả kỳ vọng |
|---|---|
| Chưa cấu hình Gateway | Có cảnh báo rõ, chỉ xem dữ liệu mẫu, không cho phép lưu |
| Gateway mất kết nối | Không hiển thị dữ liệu mẫu như dữ liệu live; không lưu |
| GET trên hai trình duyệt | Cùng số task / progress / SHA |
| Save Task | HTTP 200 chỉ sau GitHub xác nhận, SHA mới, lần sau vẫn còn |
| Cancel / Restore | Task và child roll-up đúng, GitHub lưu lại sau reload |
| Excel Import | Không đọc sheet ẩn; không tự ghi dữ liệu gốc; lưu được vào JSON chỉ khi có Admin |
| Hai Admin sửa đồng thời | Client cũ gửi SHA cũ nhận 409, không mất cập nhật của người khác |
| PUT khi chưa xác thực | HTTP 401/403, GitHub không đổi |
| Sai Origin | 403 và không có CORS cho origin lạ |
| Báo cáo/KPI | Bảo toàn 327 leaf task hiệu lực, 18 chậm, 0 rủi ro ở snapshot 09/11/2026 |
| Refresh & thiết bị khác | Đọc dữ liệu GitHub mới nhất |
| Main/Production | Không có commit do Preview/Shared Data |

## Giới hạn cần chấp nhận

- GitHub là versioned file store, không phải database có truy vấn thời gian thực. Mỗi lần cập nhật có thể tạo commit; không thích hợp nếu hàng chục Admin cập nhật liên tục.
- Repository này đang public, gồm thông tin về dự án. Phải xem xét quyền công khai trước khi dùng thực tế.
- Không deploy Worker / Access trong bước này vì chưa có tài khoản Cloudflare, URL tên miền, `ACCESS_AUD`, `ADMIN_EMAILS`, và GitHub Token Secret đã cấu hình.
- Chưa có kiểm thử end-to-end trên trình duyệt và môi trường Worker thực tế. **Không coi Preview là go-live hoàn tất.**
