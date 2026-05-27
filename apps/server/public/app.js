const state = {
  authenticated: false,
  servers: [],
  socket: null
};

const loginScreen = document.getElementById("loginScreen");
const appShell = document.getElementById("appShell");
const loginForm = document.getElementById("loginForm");
const loginTokenInput = document.getElementById("loginTokenInput");
const loginError = document.getElementById("loginError");
const logoutButton = document.getElementById("logoutButton");
const refreshButton = document.getElementById("refreshButton");
const clearOutputButton = document.getElementById("clearOutputButton");
const bootstrapForm = document.getElementById("bootstrapForm");
const bootstrapButtons = Array.from(document.querySelectorAll(".bootstrap-submit"));
const centralUrlInput = document.getElementById("centralUrlInput");
const centralUrlWarning = document.getElementById("centralUrlWarning");
const bootstrapStatus = document.getElementById("bootstrapStatus");
const summary = document.getElementById("summary");
const servers = document.getElementById("servers");
const output = document.getElementById("output");

centralUrlInput.value = window.location.origin;
updateCentralUrlWarning();

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void login();
});
logoutButton.addEventListener("click", () => {
  void logout();
});

refreshButton.addEventListener("click", () => void refresh());
clearOutputButton.addEventListener("click", () => {
  output.textContent = "";
});
bootstrapForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void bootstrapVps(new FormData(bootstrapForm));
});
centralUrlInput.addEventListener("input", updateCentralUrlWarning);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    let logs;

    try {
      const errorBody = await response.json();
      detail = errorBody.error || JSON.stringify(errorBody);
      logs = errorBody.logs;
    } catch {
      // Keep the HTTP status if the response body is not JSON.
    }

    const error = new Error(detail);
    if (logs) {
      error.logs = logs;
    }
    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function checkSession() {
  try {
    const session = await api("/api/session");
    if (session.authenticated) {
      showApp();
      return;
    }
  } catch {
    // Fall through to login screen.
  }

  showLogin();
}

async function login() {
  loginError.hidden = true;

  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        token: loginTokenInput.value.trim()
      })
    });
    loginTokenInput.value = "";
    showApp();
  } catch (error) {
    loginError.textContent = `Đăng nhập thất bại: ${error.message}`;
    loginError.hidden = false;
  }
}

async function logout() {
  try {
    await api("/api/logout", { method: "POST" });
  } finally {
    state.socket?.close();
    state.socket = null;
    state.authenticated = false;
    showLogin();
  }
}

function showApp() {
  state.authenticated = true;
  loginScreen.hidden = true;
  appShell.hidden = false;
  connectRealtime();
  void refresh();
}

function showLogin() {
  loginScreen.hidden = false;
  appShell.hidden = true;
  loginTokenInput.focus();
}

async function deleteServer(serverId, serverName) {
  if (!confirm(`Xóa VPS "${serverName}" khỏi dashboard?`)) {
    return;
  }

  try {
    await api(`/api/servers/${serverId}`, { method: "DELETE" });
    appendOutput(`[deleted] ${serverName}`);
    await refresh();
  } catch (error) {
    appendOutput(`[delete failed] ${error.message}`);
  }
}

async function bootstrapVps(formData) {
  if (!state.authenticated) {
    showLogin();
    return;
  }

  const payload = Object.fromEntries(formData.entries());
  payload.sshPort = Number(payload.sshPort || 22);

  for (const key of Object.keys(payload)) {
    if (typeof payload[key] === "string" && payload[key].trim() === "") {
      delete payload[key];
    }
  }

  if (!payload.sudoPassword && payload.password) {
    payload.sudoPassword = payload.password;
  }

  setBootstrapBusy(true);
  appendOutput(`[bootstrap] connecting to ${payload.sshUser}@${payload.ipAddress}:${payload.sshPort}`);

  try {
    const result = await api("/api/servers/bootstrap", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    appendOutput(`[bootstrap] ${result.message}`);
    for (const line of result.logs || []) {
      appendOutput(`[bootstrap] ${line}`);
    }
    bootstrapForm.reset();
    centralUrlInput.value = window.location.origin;
    updateCentralUrlWarning();
    await refresh();
  } catch (error) {
    appendOutput(`[bootstrap failed] ${error.message}`);
    for (const line of error.logs || []) {
      appendOutput(`[bootstrap] ${line}`);
    }
  } finally {
    setBootstrapBusy(false);
  }
}

function setBootstrapBusy(isBusy) {
  for (const button of bootstrapButtons) {
    button.disabled = isBusy;
    button.textContent = isBusy ? "Đang cài agent..." : "Cài agent vào VPS";
  }

  bootstrapStatus.textContent = isBusy
    ? "Đang SSH vào VPS, upload agent và tạo systemd service..."
    : "Sau khi bấm, theo dõi tiến trình ở Realtime Output bên dưới.";
}

function updateCentralUrlWarning() {
  const value = centralUrlInput.value.trim();
  const isLocalhost =
    value.includes("localhost") ||
    value.includes("127.0.0.1") ||
    value.includes("0.0.0.0");

  centralUrlWarning.hidden = !isLocalhost;
}

async function refresh() {
  if (!state.authenticated) {
    showLogin();
    return;
  }

  try {
    const list = await api("/api/servers");
    state.servers = list.sort(compareServers);
    render();
  } catch (error) {
    appendOutput(`Không tải được dữ liệu: ${error.message}`);
  }
}

function render() {
  const allServices = state.servers.flatMap((server) => server.services || []);
  const onlineServers = state.servers.filter((server) => server.status === "ONLINE").length;
  const runningServices = allServices.filter((service) => service.status === "RUNNING").length;
  const erroredServices = allServices.filter((service) => service.status === "ERRORED").length;

  summary.innerHTML = [
    summaryCard("VPS online", `${onlineServers}/${state.servers.length}`),
    summaryCard("Service running", `${runningServices}/${allServices.length}`),
    summaryCard("Service lỗi", String(erroredServices))
  ].join("");

  servers.innerHTML = state.servers.length
    ? state.servers.map(renderServer).join("")
    : `<div class="empty-state">
        <strong>Chưa có VPS nào</strong>
        <span>Nhập thông tin SSH ở form phía trên rồi bấm "Cài agent vào VPS" để bắt đầu quản lý.</span>
      </div>`;

  for (const button of document.querySelectorAll("[data-action]")) {
    button.addEventListener("click", () => {
      void runAction(button.dataset.serviceId, button.dataset.action);
    });
  }

  for (const button of document.querySelectorAll("[data-delete-server]")) {
    button.addEventListener("click", () => {
      void deleteServer(button.dataset.deleteServer, button.dataset.serverName);
    });
  }
}

function compareServers(a, b) {
  if (a.status === "ONLINE" && b.status !== "ONLINE") {
    return -1;
  }
  if (b.status === "ONLINE" && a.status !== "ONLINE") {
    return 1;
  }
  return a.name.localeCompare(b.name);
}

function summaryCard(label, value) {
  return `<div class="summary-card"><span>${label}</span><strong>${value}</strong></div>`;
}

function renderServer(server) {
  const latestMetric = server.metrics?.[0];
  const services = server.services || [];
  const memoryText = latestMetric
    ? `${formatBytes(Number(latestMetric.memoryUsed))} / ${formatBytes(Number(latestMetric.memoryTotal))}`
    : "Chưa có metric";
  const diskText = latestMetric?.diskPercent ? `${latestMetric.diskPercent.toFixed(1)}%` : "N/A";
  const isOnline = server.status === "ONLINE";
  const hostLine = [server.ipAddress, server.hostname].filter(Boolean).join(" · ") || "unknown host";

  return `
    <article class="server-row ${isOnline ? "is-online" : ""}">
      <div class="server-row-header">
        <div>
          <h3>${escapeHtml(server.name)}</h3>
          <div class="server-subtitle">${escapeHtml(hostLine)}</div>
        </div>
        <div class="metric-grid">
          <div class="metric-tile"><span>CPU</span><strong>${latestMetric ? latestMetric.cpuPercent.toFixed(1) : "0"}%</strong></div>
          <div class="metric-tile"><span>RAM</span><strong>${memoryText}</strong></div>
          <div class="metric-tile"><span>Disk</span><strong>${diskText}</strong></div>
        </div>
        <div class="server-header-actions">
          <span class="badge ${server.status.toLowerCase()}">${server.status}</span>
          <button class="danger" type="button" data-delete-server="${server.id}" data-server-name="${escapeHtml(server.name).replaceAll('"', "&quot;")}">Xóa</button>
        </div>
      </div>
      <div class="service-panel">
        <div class="service-panel-title">PM2 Services (${services.length})</div>
        <div class="service-scroll">
          <div class="service-table">
            ${
              services.length
                ? services.map(renderService).join("")
                : '<div class="empty-state" style="min-height:80px;padding:16px"><span>Chưa phát hiện PM2 service</span></div>'
            }
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderService(service) {
  return `
    <div class="service-row">
      <div class="service-info">
        <strong>${escapeHtml(service.name)}</strong>
        <div class="service-path">${escapeHtml(service.pm2Name)}${service.sourcePath ? ` · ${escapeHtml(service.sourcePath)}` : ""}</div>
      </div>
      <div class="service-meta">
        <span class="badge ${service.status.toLowerCase()}">${service.status}</span>
        <span>${service.pid ? `PID ${service.pid}` : "No PID"}</span>
        <span>${service.memoryBytes ? formatBytes(Number(service.memoryBytes)) : "—"}</span>
      </div>
      <div class="service-actions">
        <button data-service-id="${service.id}" data-action="PM2_RESTART">restart</button>
        <button class="secondary" data-service-id="${service.id}" data-action="PM2_RELOAD">reload</button>
        <button class="secondary" data-service-id="${service.id}" data-action="GIT_PULL">pull</button>
        <button class="secondary" data-service-id="${service.id}" data-action="DEPLOY">deploy</button>
        <button class="secondary" data-service-id="${service.id}" data-action="LOG_STREAM">log</button>
        <button class="danger" data-service-id="${service.id}" data-action="PM2_STOP">stop</button>
      </div>
    </div>
  `;
}

async function runAction(serviceId, action) {
  if (action === "LOG_STREAM") {
    await streamLog(serviceId);
    return;
  }

  try {
    const command = await api(`/api/services/${serviceId}/actions`, {
      method: "POST",
      body: JSON.stringify({ action })
    });
    appendOutput(`[queued] ${action} command=${command.id}`);
  } catch (error) {
    appendOutput(`[failed] ${action}: ${error.message}`);
  }
}

async function streamLog(serviceId) {
  try {
    const stream = await api(`/api/services/${serviceId}/logs/stream`, {
      method: "POST",
      body: JSON.stringify({ lines: 100 })
    });
    appendOutput(`[log] started stream=${stream.streamId}`);
  } catch (error) {
    appendOutput(`[log failed] ${error.message}`);
  }
}

function connectRealtime() {
  if (!state.authenticated) {
    return;
  }

  state.socket?.close();
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  state.socket = new WebSocket(`${protocol}//${window.location.host}/ui`);

  state.socket.addEventListener("open", () => appendOutput("[realtime] connected"));
  state.socket.addEventListener("close", () => appendOutput("[realtime] disconnected"));
  state.socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "command.output") {
      appendOutput(`[${message.payload.commandId}] ${message.payload.chunk}`);
      return;
    }

    if (message.type === "command.finished") {
      appendOutput(`[${message.payload.commandId}] finished: ${message.payload.status}`);
      void refresh();
      return;
    }

    if (message.type === "log.output") {
      appendOutput(`[log:${message.payload.pm2Name}] ${message.payload.chunk}`);
      return;
    }

    if (message.type.startsWith("alert.")) {
      appendOutput(`[alert] ${JSON.stringify(message.payload)}`);
      return;
    }

    if (message.type === "server.heartbeat" || message.type === "server.online" || message.type === "server.offline") {
      void refresh();
    }
  });
}

function appendOutput(line) {
  output.textContent += `${new Date().toLocaleTimeString()} ${line}\n`;
  output.scrollTop = output.scrollHeight;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

void checkSession();
