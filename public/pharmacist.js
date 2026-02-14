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
const voiceStatusBadge = document.getElementById("voiceStatusBadge");
const liveCallCard = document.getElementById("liveCallCard");
const liveCallTitle = document.getElementById("liveCallTitle");
const liveCallMeta = document.getElementById("liveCallMeta");
const answerCallBtn = document.getElementById("answerCallBtn");
const rejectCallBtn = document.getElementById("rejectCallBtn");
const hangupCallBtn = document.getElementById("hangupCallBtn");

let audioContext;
let titlePulseInterval;
const baseDocumentTitle = document.title;
let device = null;
let activeVoiceCall = null;
let incomingVoiceCall = null;

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

const setVoiceBadge = (text, mode) => {
  voiceStatusBadge.textContent = text;
  voiceStatusBadge.classList.remove("incoming", "danger");
  if (mode === "incoming") {
    voiceStatusBadge.classList.add("incoming");
  } else if (mode === "danger") {
    voiceStatusBadge.classList.add("danger");
  }
};

const setLiveCallUI = ({ title, meta, ringing = false, canAnswer = false, canReject = false, canHangup = false }) => {
  liveCallTitle.textContent = title;
  liveCallMeta.textContent = meta;
  liveCallCard.classList.toggle("ringing", ringing);
  answerCallBtn.disabled = !canAnswer;
  rejectCallBtn.disabled = !canReject;
  hangupCallBtn.disabled = !canHangup;
};

const callerLabelFromCall = (call) => {
  const custom = call.customParameters;
  const callerName = custom?.get ? custom.get("callerName") : null;
  const callerIdentity = custom?.get ? custom.get("callerIdentity") : null;
  return callerName || callerIdentity || call.parameters?.From || "Unknown caller";
};

const wireCallLifecycle = (call) => {
  call.on("accept", () => {
    activeVoiceCall = call;
    incomingVoiceCall = null;
    setVoiceBadge("Live connected", "incoming");
    setLiveCallUI({
      title: "Live call connected",
      meta: `Talking to ${callerLabelFromCall(call)}`,
      ringing: false,
      canAnswer: false,
      canReject: false,
      canHangup: true
    });
  });

  call.on("disconnect", () => {
    activeVoiceCall = null;
    incomingVoiceCall = null;
    setVoiceBadge("Voice online", "");
    setLiveCallUI({
      title: "No active live call",
      meta: "Waiting for incoming pharmacist calls from users.",
      ringing: false,
      canAnswer: false,
      canReject: false,
      canHangup: false
    });
    refreshIncomingBadge();
  });

  call.on("cancel", () => {
    incomingVoiceCall = null;
    setVoiceBadge("Voice online", "");
    setLiveCallUI({
      title: "Missed incoming call",
      meta: "Caller hung up before answer.",
      ringing: false,
      canAnswer: false,
      canReject: false,
      canHangup: false
    });
    refreshIncomingBadge();
  });

  call.on("reject", () => {
    incomingVoiceCall = null;
    setVoiceBadge("Voice online", "");
  });

  call.on("error", (error) => {
    console.error("Twilio call error:", error);
    setVoiceBadge("Voice error", "danger");
    setLiveCallUI({
      title: "Voice call error",
      meta: error?.message || "Unknown call error.",
      ringing: false,
      canAnswer: false,
      canReject: false,
      canHangup: false
    });
  });
};

const refreshTwilioToken = async () => {
  if (!device) return;
  const payload = await api("/twilio/token", { method: "POST", body: "{}" });
  if (payload?.token) {
    await device.updateToken(payload.token);
  }
};

const setupVoiceDevice = async () => {
  const DeviceClass = window.Twilio?.Device || window.Device;
  if (!DeviceClass) {
    setVoiceBadge("Voice SDK missing", "danger");
    setLiveCallUI({
      title: "Voice SDK missing",
      meta: "Twilio browser SDK did not load.",
      ringing: false,
      canAnswer: false,
      canReject: false,
      canHangup: false
    });
    return;
  }

  try {
    const payload = await api("/twilio/token", { method: "POST", body: "{}" });
    device = new DeviceClass(payload.token, {
      closeProtection: true,
      codecPreferences: ["opus", "pcmu"]
    });

    device.on("registered", () => {
      setVoiceBadge("Voice online", "");
      setLiveCallUI({
        title: "No active live call",
        meta: "Waiting for incoming pharmacist calls from users.",
        ringing: false,
        canAnswer: false,
        canReject: false,
        canHangup: false
      });
    });

    device.on("incoming", (call) => {
      incomingVoiceCall = call;
      wireCallLifecycle(call);
      const caller = callerLabelFromCall(call);
      setVoiceBadge("Incoming live call", "incoming");
      setLiveCallUI({
        title: "Incoming live call",
        meta: `Caller: ${caller}`,
        ringing: true,
        canAnswer: true,
        canReject: true,
        canHangup: false
      });
      ringIncoming();
      startTitlePulse();
    });

    device.on("error", (error) => {
      console.error("Twilio device error:", error);
      setVoiceBadge("Voice error", "danger");
      setLiveCallUI({
        title: "Voice line disconnected",
        meta: error?.message || "Unable to register Twilio voice line.",
        ringing: false,
        canAnswer: false,
        canReject: false,
        canHangup: false
      });
      stopTitlePulse();
    });

    device.on("tokenWillExpire", refreshTwilioToken);
    await device.register();
  } catch (error) {
    console.error("Failed to initialize Twilio voice:", error);
    setVoiceBadge("Voice unavailable", "danger");
    setLiveCallUI({
      title: "Voice setup failed",
      meta: error?.message || "Could not start pharmacist voice line.",
      ringing: false,
      canAnswer: false,
      canReject: false,
      canHangup: false
    });
  }
};

const refreshIncomingBadge = () => {
  const requestedCount = state.calls.filter((call) => call.status === "requested").length;
  const hasVoiceIncoming = Boolean(incomingVoiceCall);
  const totalIncoming = requestedCount + (hasVoiceIncoming ? 1 : 0);
  if (!totalIncoming) {
    incomingBadge.textContent = "No incoming calls";
    incomingBadge.classList.remove("incoming");
    stopTitlePulse();
    return;
  }
  incomingBadge.textContent = `${totalIncoming} incoming call${totalIncoming === 1 ? "" : "s"}`;
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

answerCallBtn.addEventListener("click", async () => {
  if (!incomingVoiceCall) return;
  try {
    await incomingVoiceCall.accept();
  } catch (error) {
    console.error("Failed to accept call:", error);
  }
});

rejectCallBtn.addEventListener("click", () => {
  if (!incomingVoiceCall) return;
  incomingVoiceCall.reject();
  incomingVoiceCall = null;
  setVoiceBadge("Voice online", "");
  setLiveCallUI({
    title: "Call declined",
    meta: "Waiting for incoming pharmacist calls from users.",
    ringing: false,
    canAnswer: false,
    canReject: false,
    canHangup: false
  });
  refreshIncomingBadge();
});

hangupCallBtn.addEventListener("click", () => {
  if (!activeVoiceCall) return;
  activeVoiceCall.disconnect();
});

refreshBtn.addEventListener("click", refreshAll);
callStatusFilter.addEventListener("change", renderCalls);
sessionSearch.addEventListener("input", renderSessions);

setVoiceBadge("Starting voice line…", "");
setLiveCallUI({
  title: "Live call line is starting…",
  meta: "Fetching Twilio token and registering browser device.",
  ringing: false,
  canAnswer: false,
  canReject: false,
  canHangup: false
});

setupVoiceDevice();
refreshAll();
setInterval(refreshAll, 5000);
