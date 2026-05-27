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
