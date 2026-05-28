async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const hasBody = options.body !== undefined && options.body !== null;

  if (hasBody && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: hasBody || Object.keys(headers).length > 0 ? headers : undefined
  });

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;

    let logs;

    try {
      const errorBody = await response.json();
      detail = errorBody.error || JSON.stringify(errorBody);
      logs = errorBody.logs;
    } catch {
      // Keep HTTP status when body is not JSON.
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function requireAuth() {
  try {
    const session = await api("/api/session");
    return Boolean(session.authenticated);
  } catch {
    return false;
  }
}

function isVpsManagerService(service) {
  return String(service.pm2Name || "").toLowerCase() === "vps-manager";
}

function isClientService(service) {
  const pm2Name = String(service.pm2Name || "").toLowerCase();
  const name = String(service.name || "").toLowerCase();
  const sourcePath = String(service.sourcePath || "").toLowerCase();

  if (
    pm2Name.includes("backend") ||
    pm2Name.endsWith("_be") ||
    pm2Name.endsWith("-be") ||
    sourcePath.includes("/backend")
  ) {
    return false;
  }

  if (pm2Name === "client" || pm2Name.startsWith("client_") || pm2Name.startsWith("client-")) {
    return true;
  }

  if (pm2Name.endsWith("_fe") || pm2Name.endsWith("-fe") || name.endsWith("_fe") || name.endsWith("-fe")) {
    return true;
  }

  if (pm2Name.includes("frontend") || name.includes("frontend")) {
    return true;
  }

  if (/\/client\/?$/.test(sourcePath) || /\/client\//.test(sourcePath)) {
    return true;
  }

  if (sourcePath.includes("/frontend") || /\/fe\/?$/.test(sourcePath)) {
    return true;
  }

  return false;
}
