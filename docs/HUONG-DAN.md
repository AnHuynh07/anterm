# AnTerm — Hướng dẫn cài đặt & sử dụng

Hướng dẫn dành cho người **tải mã nguồn từ GitHub về** và muốn chạy AnTerm.

> AnTerm là cổng SSH qua trình duyệt: mở terminal tới thiết bị mạng / máy chủ ngay trong
> tab web, có quản lý kết nối, phân quyền người dùng, ghi log phiên và nhật ký hoạt động.

---

## 1. Yêu cầu

| | |
|---|---|
| **Node.js** | 20 trở lên (`node -v`) |
| **npm** | đi kèm Node |
| **Trình biên dịch C** | `better-sqlite3` và `argon2` là native module — cần build tools: **macOS** `xcode-select --install` · **Debian/Ubuntu** `sudo apt install build-essential python3` · **Windows** dùng WSL2 hoặc "Desktop development with C++" |
| Hệ điều hành | macOS / Linux / WSL2. Windows thuần chạy được nhưng ít được kiểm thử |

Không cần cài SSH server hay Docker để chạy thử.

---

## 2. Tải mã nguồn

```bash
git clone https://github.com/AnHuynh07/anterm.git
cd anterm
```

Hoặc tải file ZIP từ GitHub (nút **Code → Download ZIP**) rồi giải nén và `cd` vào thư mục.

---

## 3. Cài đặt

```bash
npm install
```

Lệnh này cài cho cả `server/` và `web/` (dự án dùng npm workspaces). Lần đầu sẽ mất
1–3 phút vì phải build native module.

> Nếu `npm install` lỗi ở `better-sqlite3` hoặc `argon2`: thiếu build tools ở mục 1.
> `node-pty` là **optional** — lỗi ở đó thì bỏ qua được (chỉ mất chế độ shell nội bộ).

---

## 4. Cấu hình

Tạo file `.env` ở thư mục gốc:

```bash
cp .env.example .env      # nếu có, hoặc tự tạo file .env
```

Nội dung tối thiểu:

```env
# BẮT BUỘC — khoá mã hoá toàn bộ mật khẩu SSH đã lưu + ký cookie.
# Tối thiểu 16 ký tự. MẤT KHOÁ NÀY = MẤT SẠCH MẬT KHẨU ĐÃ LƯU. Hãy sao lưu.
ANTERM_APP_SECRET=doi-thanh-mot-chuoi-ngau-nhien-that-dai

# Tài khoản admin đầu tiên — chỉ được tạo khi database chưa có user nào.
ADMIN_USER=admin
ADMIN_PASSWORD=doi-mat-khau-nay-ngay
```

Sinh secret ngẫu nhiên:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Các tuỳ chọn khác (`--port`, `--allow-hosts`, `--allow-secret-export`, …): xem bảng trong
[README.md](../README.md#configuration) hoặc chạy `node server/dist/index.js --help`.

---

## 5. Chạy chế độ phát triển (dev)

```bash
npm run dev
```

- API server: `http://localhost:3000`
- Giao diện web (Vite): **`http://localhost:5173`** ← mở cái này

Vite tự proxy `/api` và `/ws` sang server nên chỉ cần một URL. Sửa code là tự nạp lại.

Ở dev, form đăng nhập tự điền sẵn `admin` / `changeme` cho tiện (không có ở bản production).
Đổi bằng `VITE_DEV_USER` / `VITE_DEV_PASSWORD` trong `web/.env.local`.

---

## 6. Chạy production

```bash
npm run build                       # build web/dist rồi server/dist (SPA nhúng vào server)
node server/dist/index.js           # đọc .env; hoặc truyền cờ trực tiếp
```

Server phục vụ cả giao diện lẫn API trên **cùng một cổng** (`ANTERM_PORT`, mặc định 3000).

**Quan trọng — bảo mật:** cổng SSH qua trình duyệt rất nhạy cảm. Luôn:
- đặt sau **reverse proxy có TLS** (nginx / Caddy / Traefik), hoặc chạy trực tiếp HTTPS với
  `--ssl-key` / `--ssl-cert`;
- giới hạn truy cập bằng VPN / mạng nội bộ / IP allowlist ở proxy;
- dùng `--allow-hosts` để chỉ cho SSH tới các host đã duyệt.

Chạy nền bằng systemd / pm2 / Docker tuỳ hạ tầng.

---

## 7. Docker (không cần cài Node)

```bash
cd docker
echo "ANTERM_APP_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" > .env
echo "ADMIN_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))")" >> .env
docker compose up --build           # http://localhost:3000
```

Deploy công khai: dùng `docker-compose.traefik.yml` (đặt `ANTERM_DOMAIN` và `ACME_EMAIL`).
Nhớ **mount volume** cho thư mục `data/` để giữ database qua các lần restart.

---

## 8. Đăng nhập lần đầu & phân quyền

1. Mở trang, đăng nhập bằng `ADMIN_USER` / `ADMIN_PASSWORD`.
2. **Settings → Change password** — đổi mật khẩu admin ngay (thao tác này đăng xuất mọi phiên khác).
3. **Users** (chỉ admin thấy) — tạo tài khoản cho từng người:
   - `admin` — quản lý user, thấy mọi kết nối/credential/phiên;
   - `operator` — tạo & dùng kết nối mình sở hữu hoặc được chia sẻ;
   - `viewer` — chỉ xem, không mở được terminal, không sửa.
   Không thể hạ cấp / khoá / xoá **admin đang hoạt động cuối cùng**.
4. **Connections → New connection** — thêm thiết bị. Với switch/router có prompt
   `Username:` / `Password:` trong terminal, mở mục **Login automation** để AnTerm tự điền.
   Cần đi qua bastion thì chọn **Advanced → Connect through**.
5. Chia sẻ một kết nối cho người khác: nút **Share** trên dòng đó.
6. **Activity** (admin) — nhật ký đăng nhập, thay đổi, chia sẻ, tin cậy host key… xuất được CSV.

---

## 9. Sao lưu

Có **hai** thứ cần giữ, mất một trong hai là không khôi phục được mật khẩu:

| Thứ | Cách sao lưu |
|---|---|
| `ANTERM_APP_SECRET` | Chép ra nơi an toàn (password manager). |
| Database (`data/anterm.sqlite`) | **Settings → Backup → Download database**, hoặc copy file. |

**Tốt hơn:** dùng **Settings → Backup → Export vault** định dạng **`.anterm` mã hoá**
(nhập passphrase riêng). File này chứa mọi kết nối + mật khẩu, và **mở lại được ở máy khác kể
cả khi `ANTERM_APP_SECRET` khác**. Import lại ở mục cùng chỗ, hoặc bằng CLI:

```bash
npm -w server run vault -- export backup.anterm --passphrase 'chuoi-bi-mat'
npm -w server run vault -- import backup.anterm --passphrase 'chuoi-bi-mat' --mode replace
```

Muốn cấm hẳn tính năng xuất secret trên bản deploy khoá chặt: `--allow-secret-export=false`.

---

## 10. Cập nhật phiên bản mới

```bash
git pull
npm install          # nếu package.json đổi
npm run build        # bản production
# rồi restart server
```

Database tự chạy migration khi khởi động (migration chỉ tiến, không lùi) — **nên sao lưu
DB trước khi update** bản lớn.

---

## 11. Xử lý sự cố

| Triệu chứng | Cách xử lý |
|---|---|
| `npm install` lỗi native build | Cài build tools ở mục 1. Xoá `node_modules` + `package-lock.json` rồi cài lại. |
| Khởi động báo thiếu `ANTERM_APP_SECRET` | Đặt trong `.env` (≥ 16 ký tự) hoặc truyền `--app-secret`. |
| Không đăng nhập được, log ghi "No users exist" | Đặt `ADMIN_USER` / `ADMIN_PASSWORD` rồi khởi động lại (chỉ tạo khi DB rỗng). |
| Mở kết nối bị hỏi host key mãi | Bấm **Trust and continue** một lần; nếu key đổi thật sẽ có cảnh báo đỏ. |
| Terminal trắng / lỗi WebSocket | Kiểm tra proxy có chuyển tiếp `Upgrade`/`Connection` cho đường `/ws`. |
| `node-pty` build lỗi | Bỏ qua — chỉ ảnh hưởng chế độ `--ssh-host localhost` (shell nội bộ). |
| Thiết bị mạng cắt phiên khi để yên | Đặt **Anti-idle** (Advanced) hoặc `--ssh-idle-timeout-min 0`. |

Chi tiết kiến trúc, danh sách cờ đầy đủ, ghi chú bảo mật: xem [README.md](../README.md).
