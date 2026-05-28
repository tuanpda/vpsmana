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
const openInstallModalButton = document.getElementById("openInstallModalButton");
const installModalRoot = document.getElementById("installModalRoot");
const closeInstallModalButton = document.getElementById("closeInstallModalButton");
const clearOutputButton = document.getElementById("clearOutputButton");
const bootstrapForm = document.getElementById("bootstrapForm");
const bootstrapButtons = Array.from(document.querySelectorAll(".bootstrap-submit"));
const centralUrlInput = document.getElementById("centralUrlInput");
const centralUrlWarning = document.getElementById("centralUrlWarning");
const bootstrapStatus = document.getElementById("bootstrapStatus");
const summary = document.getElementById("summary");
const servers = document.getElementById("servers");
const output = document.getElementById("output");
const dialogRoot = document.getElementById("dialogRoot");
const dialogIcon = document.getElementById("dialogIcon");
const dialogTitle = document.getElementById("dialogTitle");
const dialogMessage = document.getElementById("dialogMessage");
const dialogCancel = document.getElementById("dialogCancel");
const dialogConfirm = document.getElementById("dialogConfirm");

let dialogResolver = null;
let installModalOpen = false;
let bootstrapBusy = false;

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
openInstallModalButton.addEventListener("click", () => openInstallModal());
closeInstallModalButton.addEventListener("click", () => closeInstallModal());
installModalRoot.querySelector("[data-install-dismiss]").addEventListener("click", () => closeInstallModal());
clearOutputButton.addEventListener("click", () => {
  output.textContent = "";
});
bootstrapForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void bootstrapVps(new FormData(bootstrapForm));
});
centralUrlInput.addEventListener("input", updateCentralUrlWarning);

dialogCancel.addEventListener("click", () => closeDialog(false));
dialogConfirm.addEventListener("click", () => closeDialog(true));
dialogRoot.querySelector("[data-dialog-dismiss]").addEventListener("click", () => closeDialog(false));
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }

  if (!dialogRoot.hidden) {
    closeDialog(false);
    return;
  }

  if (installModalOpen && !bootstrapBusy) {
    closeInstallModal();
  }
});

function openInstallModal() {
  installModalOpen = true;
  installModalRoot.hidden = false;
  document.body.style.overflow = "hidden";
  bootstrapForm.querySelector('input[name="name"]')?.focus();
}

function closeInstallModal() {
  if (bootstrapBusy) {
    return;
  }

  installModalOpen = false;
  installModalRoot.hidden = true;
  if (dialogRoot.hidden) {
    document.body.style.overflow = "";
  }
}

function updatePageScrollLock() {
  document.body.style.overflow = !dialogRoot.hidden || installModalOpen ? "hidden" : "";
}

function openDialog(options) {
  const {
    variant = "info",
    alertOnly = false,
    title,
    message,
    icon,
    confirmLabel = "Xác nhận",
    cancelLabel = "Hủy"
  } = options;

  dialogRoot.classList.remove("is-danger", "is-info", "is-alert-only");
  dialogRoot.classList.add(variant === "danger" ? "is-danger" : "is-info");
  if (alertOnly) {
    dialogRoot.classList.add("is-alert-only");
  }

  dialogIcon.textContent = icon;
  dialogTitle.textContent = title;
  dialogMessage.innerHTML = message;
  dialogCancel.textContent = cancelLabel;
  dialogConfirm.textContent = confirmLabel;
  dialogRoot.hidden = false;
  updatePageScrollLock();
  dialogConfirm.focus();

  return new Promise((resolve) => {
    dialogResolver = resolve;
  });
}

function closeDialog(confirmed) {
  if (!dialogResolver) {
    return;
  }

  dialogRoot.hidden = true;
  updatePageScrollLock();
  const resolve = dialogResolver;
  dialogResolver = null;
  resolve(confirmed);
}

function confirmDialog(options) {
  return openDialog({
    variant: options.variant ?? "danger",
    alertOnly: false,
    title: options.title,
    message: options.message,
    icon: options.icon ?? "!",
    confirmLabel: options.confirmLabel ?? "Xóa",
    cancelLabel: options.cancelLabel ?? "Hủy"
  });
}

function alertDialog(options) {
  return openDialog({
    variant: options.variant ?? "info",
    alertOnly: true,
    title: options.title,
    message: options.message,
    icon: options.icon ?? "i",
    confirmLabel: options.confirmLabel ?? "Đóng"
  }).then(() => undefined);
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
    loginError.textContent = `Sign in failed: ${error.message}`;
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
  const confirmed = await confirmDialog({
    title: "Xóa VPS khỏi dashboard?",
    message: `Bạn sắp xóa <strong>${escapeHtml(serverName)}</strong>. Agent trên VPS vẫn chạy nhưng sẽ không còn hiển thị ở đây cho đến khi cài lại.`,
    confirmLabel: "Xóa VPS",
    cancelLabel: "Giữ lại"
  });

  if (!confirmed) {
    return;
  }

  const previousServers = state.servers;
  state.servers = state.servers.filter((server) => server.id !== serverId);
  render();

  try {
    await api(`/api/servers/${serverId}`, { method: "DELETE" });
    appendOutput(`[deleted] ${serverName}`);
  } catch (error) {
    state.servers = previousServers;
    render();
    await alertDialog({
      variant: "danger",
      title: "Không xóa được VPS",
      message: escapeHtml(error.message),
      icon: "×",
      confirmLabel: "Đóng"
    });
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
    closeInstallModal();
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
  bootstrapBusy = isBusy;
  installModalRoot.dataset.busy = isBusy ? "true" : "false";
  closeInstallModalButton.disabled = isBusy;

  for (const button of bootstrapButtons) {
    button.disabled = isBusy;
    button.textContent = isBusy ? "Đang cài agent..." : "Cài agent vào VPS";
  }

  openInstallModalButton.disabled = isBusy;

  bootstrapStatus.textContent = isBusy
    ? "Đang SSH vào VPS, upload agent và tạo systemd service..."
    : "Sau khi bấm, theo dõi tiến trình ở Realtime Output phía dưới.";
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
        <span>Bấm <strong>+ Thêm VPS</strong> trên thanh menu để cài agent và bắt đầu quản lý.</span>
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

function findServiceById(serviceId) {
  for (const server of state.servers) {
    const service = (server.services || []).find((item) => item.id === serviceId);
    if (service) {
      return { server, service };
    }
  }

  return null;
}

function renderService(service) {
  const clientBuildButton =
    isClientService(service) && service.sourcePath
      ? `<button class="secondary" data-service-id="${service.id}" data-action="NPM_BUILD">build</button>`
      : "";

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
        ${clientBuildButton}
        <button class="secondary" data-service-id="${service.id}" data-action="LOG_STREAM">log</button>
        <button class="danger" data-service-id="${service.id}" data-action="PM2_STOP">stop</button>
        <button class="danger secondary" data-service-id="${service.id}" data-action="PM2_DELETE">xóa</button>
      </div>
    </div>
  `;
}

async function runAction(serviceId, action) {
  if (action === "LOG_STREAM") {
    await streamLog(serviceId);
    return;
  }

  if (action === "PM2_DELETE") {
    const match = findServiceById(serviceId);
    if (!match) {
      return;
    }

    const confirmed = await confirmDialog({
      title: "Xóa tiến trình PM2?",
      message: `Tiến trình <strong>${escapeHtml(match.service.pm2Name)}</strong> sẽ bị gỡ khỏi PM2 trên VPS <strong>${escapeHtml(match.server.name)}</strong>. Thao tác này không hoàn tác được.`,
      confirmLabel: "Xóa tiến trình",
      cancelLabel: "Giữ lại"
    });

    if (!confirmed) {
      return;
    }
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

void checkSession();
