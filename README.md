# VPS Manager

Web control panel để quản lý nhiều VPS đang chạy nhiều PM2 service. Kiến trúc gồm central server và agent cài trên từng VPS.

## Tính năng hiện có

- Dashboard tổng quan VPS/service, trạng thái online/offline, CPU/RAM/disk.
- Agent kết nối outbound WebSocket về central server bằng token riêng từng VPS.
- Tự động discovery PM2 service bằng `pm2 jlist`.
- Heartbeat định kỳ gửi metric hệ thống và trạng thái PM2.
- Command runner allowlist: `pm2 start/stop/restart/reload`, `git pull`, `npm install`, `npm run build`, `deploy`.
- Stream output command realtime về dashboard.
- Stream PM2 log realtime từ từng service.
- Cài agent lên VPS cloud qua SSH bằng IP, user, port, password hoặc private key.
- Audit log cho thao tác tạo server, chạy command và xem log.
- Cảnh báo realtime cơ bản khi disk >= 90% hoặc PM2 service errored.

## Chạy local

1. Cài dependency:

   ```bash
   npm install
   ```

2. Tạo `.env` từ mẫu:

   ```bash
   cp .env.example .env
   ```

3. Chạy Postgres:

   ```bash
   docker compose up -d postgres
   ```

4. Tạo Prisma client và đẩy schema:

   ```bash
   npm run db:generate
   npm run db:push
   ```

5. Chạy central server:

   ```bash
   npm run server:dev
   ```

6. Mở dashboard:

   ```text
   http://localhost:8080
   ```

   Nhập `ADMIN_TOKEN` trong file `.env` vào ô token trên dashboard.

## Thêm VPS mới

Trên dashboard, dùng form **Thêm VPS Cloud**:

- `Tên VPS`: tên dễ nhớ, ví dụ `backend_nghiadan`.
- `IP VPS`: IP public hoặc private mà máy chạy dashboard truy cập SSH được.
- `SSH port`: thường là `22`.
- `SSH user`: user dùng để login VPS.
- `User chạy PM2`: nên là user đang chạy PM2 trên VPS. Để trống thì dùng SSH user.
- `Central URL public`: URL mà VPS cloud truy cập được để kết nối ngược về dashboard, ví dụ `https://manager.example.com`. Không dùng `localhost` cho VPS cloud.
- `SSH password` hoặc `Private key`: chỉ dùng trong lúc cài agent, không lưu vào database.

Khi bấm **Cài agent vào VPS**, hệ thống sẽ:

1. Tạo server và agent token.
2. SSH vào VPS.
3. Upload agent đã build vào `/opt/vps-manager-agent`.
4. Chạy `npm install --omit=dev` trên VPS.
5. Tạo `systemd` service `vps-manager-agent`.
6. Start agent để VPS tự gửi PM2/CPU/RAM/disk về dashboard.

VPS cần có sẵn `node`, `npm`, `pm2` và user SSH có quyền `sudo`.

Nếu muốn tạo server thủ công, có thể gọi API:

```bash
curl -X POST http://localhost:8080/api/servers \
  -H "Authorization: Bearer change-me-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"name":"vps-01"}'
```

Copy `agentToken` trả về, rồi chạy agent trên VPS:

```bash
CENTRAL_URL=ws://manager.example.com \
AGENT_TOKEN=paste-server-agent-token-here \
AGENT_NAME=vps-01 \
npm run agent:dev
```

Khi deploy thật, build project trước khi cài agent qua SSH:

```bash
npm run build
```

## Luồng điều khiển

```mermaid
flowchart LR
    Dashboard["Admin Dashboard"] --> Api["Central API"]
    Api --> Db["Postgres"]
    Api --> Ws["WebSocket Gateway"]
    Agent["VPS Agent"] <-->|"Outbound WebSocket"| Ws
    Agent --> PM2["PM2"]
    Agent --> Git["Git Repo"]
    Agent --> OS["CPU, RAM, Disk"]
```

## Lưu ý bảo mật

- Đổi `ADMIN_TOKEN` trước khi expose ra internet.
- Agent token chỉ hiển thị một lần khi tạo server, nếu lộ thì tạo server/token mới.
- Agent không nhận shell tự do, chỉ chạy command trong allowlist.
- Nên đặt central server sau HTTPS reverse proxy.
- Nên cấu hình firewall để chỉ public cổng dashboard/API cần thiết.
