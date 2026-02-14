const state = {
  sessions: [],
  calls: [],
  activeSessionId: null,
  userSessionCounts: {},
  requestedCallIds: new Set(),
  callsHydrated: false
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
const incomingBadge = document.getElementById("incomingBadge");

let audioContext;
let titlePulseInterval;
const baseDocumentTitle = document.title;

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

const userNameForSession = (session) =>
  session.userDisplayName ||
  session.userEmail ||
  (session.userId ? `User ${session.userId.slice(0, 6)}` : "Unknown user");

const userNameForCall = (call) =>
  call.callerName ||
  call.userDisplayName ||
  call.userEmail ||
  (call.userId ? `User ${call.userId.slice(0, 6)}` : "Unknown caller");

const short = (value, max = 80) => {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

const buildUserSessionCounts = (sessions) => {
  const counts = {};
  sessions.forEach((session) => {
    if (!session.userId) return;
    counts[session.userId] = (counts[session.userId] || 0) + 1;
  });
  return counts;
};

const startTitlePulse = () => {
  if (titlePulseInterval) return;
  let toggle = false;
  titlePulseInterval = setInterval(() => {
    toggle = !toggle;
    document.title = toggle ? "Incoming call • Symptom Nerd" : baseDocumentTitle;
  }, 900);
};

const stopTitlePulse = () => {
  if (!titlePulseInterval) return;
  clearInterval(titlePulseInterval);
  titlePulseInterval = null;
  document.title = baseDocumentTitle;
};

const ringIncoming = () => {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioContext) {
      audioContext = new Ctx();
    }
    const beeps = [0, 0.22, 0.44];
    beeps.forEach((delay) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 988;
      oscillator.connect(gain);
      gain.connect(audioContext.destination);

      const now = audioContext.currentTime + delay;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.15, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
      oscillator.start(now);
      oscillator.stop(now + 0.15);
    });
  } catch {
    // Best effort only.
  }
};

const refreshIncomingBadge = () => {
  const requestedCount = state.calls.filter((call) => call.status === "requested").length;
  if (!requestedCount) {
    incomingBadge.textContent = "No incoming calls";
    incomingBadge.classList.remove("incoming");
    stopTitlePulse();
    return;
  }
  incomingBadge.textContent = `${requestedCount} incoming call${requestedCount === 1 ? "" : "s"}`;
  incomingBadge.classList.add("incoming");
  startTitlePulse();
};

const setActiveSession = async (sessionId) => {
  state.activeSessionId = sessionId;
  renderSessions();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  const name = userNameForSession(session);
  sessionTitle.textContent = name;
  sessionSubtitle.textContent = `Created ${formatTime(session.createdAt)} • ${session.userId || "unknown id"}`;
  statusTextInput.value = session.statusText || "";
  queuePositionInput.value = session.queuePosition ?? "";
  await loadMessages(sessionId);
};

const renderSessions = () => {
  const query = sessionSearch.value.trim().toLowerCase();
  const filtered = state.sessions.filter((session) => {
    if (!query) return true;
    const text = [
      session.userDisplayName,
      session.userEmail,
      session.handoff?.userMessage,
      session.handoff?.summarizedLogs
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return text.includes(query);
  });

  sessionsList.innerHTML = "";
  filtered.forEach((session) => {
    const li = document.createElement("li");
    li.className = `list-item ${session.id === state.activeSessionId ? "active" : ""}`;
    const name = userNameForSession(session);
    const count = state.userSessionCounts[session.userId] || 1;
    const isReturning = count > 1;
    const starter = short(session.handoff?.userMessage || "New chat");
    li.innerHTML = `
      <div class="title">${name}<span class="pill ${isReturning ? "returning" : "new"}">${isReturning ? "Returning" : "New"}</span></div>
      <div class="meta">${starter}</div>
      <div class="meta">${session.statusText || "Pending"} • ${formatTime(session.updatedAt || session.createdAt)}</div>
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
    li.className = `list-item ${call.status === "requested" ? "incoming" : ""}`;
    const caller = userNameForCall(call);
    li.innerHTML = `
      <div class="title">${caller}${call.status === "requested" ? '<span class="pill requested">Incoming</span>' : ""}</div>
      <div class="meta">${short(call.handoff?.userMessage || "Call request")}</div>
      <div class="meta">Status: ${call.status || "requested"} • ${formatTime(call.createdAt)}</div>
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
  state.userSessionCounts = buildUserSessionCounts(state.sessions);
  if (state.activeSessionId) {
    const exists = state.sessions.some((session) => session.id === state.activeSessionId);
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

  const currentRequested = new Set(
    state.calls.filter((call) => call.status === "requested").map((call) => call.id)
  );

  if (state.callsHydrated) {
    const hasNewIncoming = [...currentRequested].some((id) => !state.requestedCallIds.has(id));
    if (hasNewIncoming) {
      ringIncoming();
    }
  }

  state.requestedCallIds = currentRequested;
  state.callsHydrated = true;

  renderCalls();
  refreshIncomingBadge();
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
setInterval(refreshAll, 5000);
