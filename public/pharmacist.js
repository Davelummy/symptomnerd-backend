const state = {
  sessions: [],
  calls: [],
  activeSessionId: null
};

const sessionsList = document.getElementById("sessionsList");
const callsList = document.getElementById("callsList");
const messageForm = document.getElementById("messageForm");
const messageInput = document.getElementById("messageInput");
const messagesEl = document.getElementById("messages");
const sessionTitle = document.getElementById("sessionTitle");
const sessionSubtitle = document.getElementById("sessionSubtitle");
const statusTextInput = document.getElementById("statusText");
const queuePositionInput = document.getElementById("queuePosition");
const saveStatusBtn = document.getElementById("saveStatus");
const refreshBtn = document.getElementById("refreshBtn");
const lastRefresh = document.getElementById("lastRefresh");
const sessionSearch = document.getElementById("sessionSearch");
const callStatusFilter = document.getElementById("callStatusFilter");

const api = async (path, options = {}) => {
  const response = await fetch(`/pharmacist/api${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Request failed");
  }
  return response.json();
};

const formatTime = (value) => {
  if (!value) return "--";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
};

const setActiveSession = async (sessionId) => {
  state.activeSessionId = sessionId;
  renderSessions();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  sessionTitle.textContent = session.handoff?.userMessage || "Chat session";
  sessionSubtitle.textContent = `Created ${formatTime(session.createdAt)} • User ${session.userId || "unknown"}`;
  statusTextInput.value = session.statusText || "";
  queuePositionInput.value = session.queuePosition ?? "";
  await loadMessages(sessionId);
};

const renderSessions = () => {
  const query = sessionSearch.value.trim().toLowerCase();
  const filtered = state.sessions.filter((session) => {
    if (!query) return true;
    const text = `${session.handoff?.userMessage || ""} ${session.handoff?.summarizedLogs || ""}`.toLowerCase();
    return text.includes(query);
  });

  sessionsList.innerHTML = "";
  filtered.forEach((session) => {
    const li = document.createElement("li");
    li.className = `list-item ${session.id === state.activeSessionId ? "active" : ""}`;
    li.innerHTML = `
      <div class="title">${session.handoff?.userMessage || "New chat"}</div>
      <div class="meta">${session.statusText || "Pending"} • ${formatTime(session.updatedAt || session.createdAt)}</div>
      <div class="meta">Phone: ${session.handoff?.contactPhone || "--"}</div>
    `;
    li.addEventListener("click", () => setActiveSession(session.id));
    sessionsList.appendChild(li);
  });
};

const renderMessages = (messages) => {
  messagesEl.innerHTML = "";
  messages.forEach((message) => {
    const wrapper = document.createElement("div");
    wrapper.className = `message ${message.role || "system"}`;
    wrapper.innerHTML = `
      <div>${message.content || ""}</div>
      <div class="message-meta">${formatTime(message.createdAt)}</div>
    `;
    messagesEl.appendChild(wrapper);
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
};

const renderCalls = () => {
  const filter = callStatusFilter.value;
  const filtered = state.calls.filter((call) => (filter === "all" ? true : call.status === filter));
  callsList.innerHTML = "";
  filtered.forEach((call) => {
    const li = document.createElement("li");
    li.className = "list-item";
    li.innerHTML = `
      <div class="title">${call.phone || call.handoff?.contactPhone || "No phone"}</div>
      <div class="meta">${call.handoff?.userMessage || "Call request"}</div>
      <div class="meta">Status: ${call.status || "requested"}</div>
      <div class="meta">${formatTime(call.createdAt)}</div>
      <div class="call-actions">
        <button data-action="in_progress">In progress</button>
        <button data-action="completed">Completed</button>
        <button data-action="cancelled">Cancelled</button>
      </div>
    `;
    li.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await updateCallStatus(call.id, btn.dataset.action);
      });
    });
    callsList.appendChild(li);
  });
};

const loadSessions = async () => {
  const data = await api("/sessions");
  state.sessions = data.sessions || [];
  if (state.activeSessionId) {
    const exists = state.sessions.some((s) => s.id === state.activeSessionId);
    if (!exists) {
      state.activeSessionId = null;
    }
  }
  renderSessions();
};

const loadMessages = async (sessionId) => {
  const data = await api(`/sessions/${sessionId}/messages`);
  renderMessages(data.messages || []);
};

const loadCalls = async () => {
  const data = await api("/calls");
  state.calls = data.calls || [];
  renderCalls();
};

const updateCallStatus = async (callId, status) => {
  await api(`/calls/${callId}/status`, {
    method: "POST",
    body: JSON.stringify({ status })
  });
  await loadCalls();
};

const refreshAll = async () => {
  await Promise.all([loadSessions(), loadCalls()]);
  if (state.activeSessionId) {
    await loadMessages(state.activeSessionId);
  }
  lastRefresh.textContent = `Last refresh: ${new Date().toLocaleTimeString()}`;
};

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.activeSessionId) return;
  const content = messageInput.value.trim();
  if (!content) return;
  messageInput.value = "";
  await api(`/sessions/${state.activeSessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content })
  });
  await loadMessages(state.activeSessionId);
});

saveStatusBtn.addEventListener("click", async () => {
  if (!state.activeSessionId) return;
  await api(`/sessions/${state.activeSessionId}/status`, {
    method: "POST",
    body: JSON.stringify({
      statusText: statusTextInput.value.trim(),
      queuePosition: queuePositionInput.value ? Number(queuePositionInput.value) : null
    })
  });
  await refreshAll();
});

refreshBtn.addEventListener("click", refreshAll);
callStatusFilter.addEventListener("change", renderCalls);
sessionSearch.addEventListener("input", renderSessions);

refreshAll();
setInterval(refreshAll, 15000);
