const MAX_BUFFER_CHARS = 120_000;
const PREVIEW_LINES = 8;
const STREAM_BATCH_SIZE = 4;

const state = {
  socket: null,
  streams: new Map(),
  streamIdToServiceId: new Map(),
  activeServiceId: null,
  modalAutoscroll: true
};

const logsStatus = document.getElementById("logsStatus");
const logsRefreshButton = document.getElementById("logsRefreshButton");
const logsGrid = document.getElementById("logsGrid");
const logsEmpty = document.getElementById("logsEmpty");
const logModalRoot = document.getElementById("logModalRoot");
const logModalTitle = document.getElementById("logModalTitle");
const logModalMeta = document.getElementById("logModalMeta");
const logModalOutput = document.getElementById("logModalOutput");
const logModalAutoscroll = document.getElementById("logModalAutoscroll");
const logModalClear = document.getElementById("logModalClear");
const logModalClose = document.getElementById("logModalClose");
const logModalActions = document.getElementById("logModalActions");

logsRefreshButton.addEventListener("click", () => void restartMonitor());
logModalActions.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) {
    return;
  }

  void runServiceAction(button.dataset.action);
});
logModalClose.addEventListener("click", closeLogModal);
logModalRoot.querySelector("[data-log-modal-dismiss]").addEventListener("click", closeLogModal);
logModalClear.addEventListener("click", () => clearStreamBuffer(state.activeServiceId));
logModalAutoscroll.addEventListener("change", () => {
  state.modalAutoscroll = logModalAutoscroll.checked;
  scrollModalToEnd();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !logModalRoot.hidden) {
    closeLogModal();
  }
});

window.addEventListener("beforeunload", () => {
  void stopAllStreams();
});

void bootstrapMonitor();

async function bootstrapMonitor() {
  if (!(await requireAuth())) {
    window.location.href = "/";
    return;
  }

  connectRealtime();
  await restartMonitor();
}

async function restartMonitor() {
  setStatus("Đang tải danh sách...", false);
  logsRefreshButton.disabled = true;

  await stopAllStreams();
  state.streams.clear();
  state.streamIdToServiceId.clear();

  try {
    const servers = await api("/api/servers");
    const entries = [];

    for (const server of servers) {
      if (server.status !== "ONLINE") {
        continue;
      }

      for (const service of server.services || []) {
        if (service.status !== "RUNNING") {
          continue;
        }

        entries.push({
          serviceId: service.id,
          serverId: server.id,
          serverName: server.name,
          serviceName: service.name,
          pm2Name: service.pm2Name,
          sourcePath: service.sourcePath || "",
          label: `${server.name} / ${service.pm2Name}`,
          text: "",
          streamId: null,
          streamState: "idle",
          tile: null
        });
      }
    }

    if (!entries.length) {
      logsGrid.hidden = true;
      logsEmpty.hidden = false;
      setStatus("Không có stream", false);
      return;
    }

    logsEmpty.hidden = true;
    logsGrid.hidden = false;
    logsGrid.innerHTML = "";

    for (const entry of entries) {
      state.streams.set(entry.serviceId, entry);
      logsGrid.appendChild(createLogTile(entry));
    }

    setStatus(`Đang mở ${entries.length} stream...`, false);
    await startStreamsInBatches(entries);
    setStatus(`${entries.length} stream đang chạy`, true);
  } catch (error) {
    setStatus(`Lỗi: ${error.message}`, false);
  } finally {
    logsRefreshButton.disabled = false;
  }
}

function createLogTile(entry) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "log-tile";
  button.dataset.serviceId = entry.serviceId;
  button.innerHTML = `
    <div class="log-tile-head">
      <div>
        <p class="log-tile-title">${escapeHtml(entry.label)}</p>
        <div class="log-tile-subtitle">${escapeHtml(entry.serviceName)} · ${escapeHtml(entry.serverName)}</div>
      </div>
      <span class="badge running">LIVE</span>
    </div>
    <pre class="log-tile-preview" aria-hidden="true">Đang kết nối log stream...</pre>
    <div class="log-tile-foot">
      <span data-stream-state>Đang kết nối</span>
      <span data-line-count>0 dòng</span>
    </div>
  `;

  button.addEventListener("click", () => openLogModal(entry.serviceId));
  entry.tile = button;
  return button;
}

async function startStreamsInBatches(entries) {
  for (let index = 0; index < entries.length; index += STREAM_BATCH_SIZE) {
    const batch = entries.slice(index, index + STREAM_BATCH_SIZE);
    await Promise.all(batch.map((entry) => startStream(entry)));
  }
}

async function startStream(entry) {
  updateStreamState(entry, "connecting");

  try {
    const result = await api(`/api/services/${entry.serviceId}/logs/stream`, {
      method: "POST",
      body: JSON.stringify({ lines: 120 })
    });

    entry.streamId = result.streamId;
    entry.streamState = "live";
    state.streamIdToServiceId.set(result.streamId, entry.serviceId);
    appendChunk(entry.serviceId, `[connected ${new Date().toLocaleTimeString()}]\n`);
    updateStreamState(entry, "live");
  } catch (error) {
    entry.streamState = "error";
    appendChunk(entry.serviceId, `[stream error] ${error.message}\n`);
    updateStreamState(entry, "error");
  }
}

async function stopAllStreams() {
  const stops = [];

  for (const entry of state.streams.values()) {
    if (!entry.streamId) {
      continue;
    }

    stops.push(
      api(`/api/servers/${entry.serverId}/logs/${entry.streamId}/stop`, {
        method: "POST"
      }).catch(() => undefined)
    );
  }

  await Promise.all(stops);
  state.streamIdToServiceId.clear();
}

function connectRealtime() {
  state.socket?.close();
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  state.socket = new WebSocket(`${protocol}//${window.location.host}/ui`);

  state.socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "log.output") {
      const serviceId = state.streamIdToServiceId.get(message.payload.streamId);
      if (serviceId) {
        appendChunk(serviceId, message.payload.chunk);
      }
      return;
    }

    if (message.type === "log.ended") {
      const serviceId = state.streamIdToServiceId.get(message.payload.streamId);
      if (serviceId) {
        const entry = state.streams.get(serviceId);
        if (entry) {
          entry.streamState = "ended";
          appendChunk(serviceId, `\n[stream ended ${new Date().toLocaleTimeString()}]\n`);
          updateStreamState(entry, "ended");
        }
        state.streamIdToServiceId.delete(message.payload.streamId);
      }
      return;
    }

    if (message.type === "command.output" && state.activeServiceId) {
      appendChunk(state.activeServiceId, message.payload.chunk || "");
      return;
    }

    if (message.type === "command.finished" && state.activeServiceId) {
      appendChunk(
        state.activeServiceId,
        `\n[command finished] ${message.payload.status || "unknown"}\n`
      );
    }
  });
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function appendChunk(serviceId, chunk) {
  const entry = state.streams.get(serviceId);
  if (!entry) {
    return;
  }

  entry.text += stripAnsi(chunk);
  if (entry.text.length > MAX_BUFFER_CHARS) {
    entry.text = entry.text.slice(entry.text.length - MAX_BUFFER_CHARS);
  }

  updateTilePreview(entry);
  updateLineCount(entry);

  if (state.activeServiceId === serviceId) {
    logModalOutput.textContent = entry.text;
    scrollModalToEnd();
  }
}

function updateTilePreview(entry) {
  if (!entry.tile) {
    return;
  }

  const preview = entry.tile.querySelector(".log-tile-preview");
  const lines = entry.text.split("\n").filter((line, index, all) => line.length > 0 || index < all.length - 1);
  preview.textContent = lines.slice(-PREVIEW_LINES).join("\n") || "—";
}

function updateLineCount(entry) {
  if (!entry.tile) {
    return;
  }

  const count = entry.text ? entry.text.split("\n").length : 0;
  entry.tile.querySelector("[data-line-count]").textContent = `${count} dòng`;
}

function updateStreamState(entry, stateName) {
  if (!entry.tile) {
    return;
  }

  entry.tile.classList.toggle("is-error", stateName === "error");
  entry.tile.classList.toggle("is-active", state.activeServiceId === entry.serviceId);

  const labels = {
    connecting: "Đang kết nối",
    live: "Đang stream",
    ended: "Đã dừng",
    error: "Lỗi stream",
    idle: "Chờ"
  };

  entry.tile.querySelector("[data-stream-state]").textContent = labels[stateName] || stateName;
}

function openLogModal(serviceId) {
  const entry = state.streams.get(serviceId);
  if (!entry) {
    return;
  }

  state.activeServiceId = serviceId;
  logModalTitle.textContent = entry.label;
  const metaParts = [entry.serviceName, entry.serverName, entry.pm2Name];
  if (entry.sourcePath) {
    metaParts.push(entry.sourcePath);
  }
  logModalMeta.textContent = metaParts.join(" · ");
  logModalOutput.textContent = entry.text || "Chưa có dữ liệu log.";
  setModalActionsBusy(false);
  logModalRoot.hidden = false;
  document.body.style.overflow = "hidden";

  for (const stream of state.streams.values()) {
    stream.tile?.classList.toggle("is-active", stream.serviceId === serviceId);
  }

  scrollModalToEnd();
}

function closeLogModal() {
  logModalRoot.hidden = true;
  document.body.style.overflow = "";

  if (state.activeServiceId) {
    const entry = state.streams.get(state.activeServiceId);
    entry?.tile?.classList.remove("is-active");
  }

  state.activeServiceId = null;
}

function clearStreamBuffer(serviceId) {
  const entry = state.streams.get(serviceId);
  if (!entry) {
    return;
  }

  entry.text = "";
  updateTilePreview(entry);
  updateLineCount(entry);

  if (state.activeServiceId === serviceId) {
    logModalOutput.textContent = "";
  }
}

function scrollModalToEnd() {
  if (!state.modalAutoscroll) {
    return;
  }

  logModalOutput.scrollTop = logModalOutput.scrollHeight;
}

function setStatus(text, isLive) {
  logsStatus.textContent = text;
  logsStatus.classList.toggle("is-live", isLive);
}

function setModalActionsBusy(isBusy) {
  for (const button of logModalActions.querySelectorAll("button")) {
    button.disabled = isBusy;
  }
}

async function runServiceAction(action) {
  const serviceId = state.activeServiceId;
  const entry = serviceId ? state.streams.get(serviceId) : null;

  if (!entry) {
    return;
  }

  if (action === "LOG_RESTART") {
    setModalActionsBusy(true);
    try {
      appendChunk(serviceId, `\n[log] restarting stream ${new Date().toLocaleTimeString()}\n`);
      if (entry.streamId) {
        await api(`/api/servers/${entry.serverId}/logs/${entry.streamId}/stop`, {
          method: "POST"
        }).catch(() => undefined);
        state.streamIdToServiceId.delete(entry.streamId);
        entry.streamId = null;
      }
      await startStream(entry);
    } finally {
      setModalActionsBusy(false);
    }
    return;
  }

  setModalActionsBusy(true);
  appendChunk(serviceId, `\n[${action}] đang gửi lệnh...\n`);

  try {
    const command = await api(`/api/services/${serviceId}/actions`, {
      method: "POST",
      body: JSON.stringify({ action })
    });
    appendChunk(serviceId, `[${action}] queued command=${command.id}\n`);
  } catch (error) {
    appendChunk(serviceId, `[${action} failed] ${error.message}\n`);
  } finally {
    setModalActionsBusy(false);
  }
}
