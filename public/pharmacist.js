const state = {
  sessions: [],
  calls: [],
  activeSessionId: null,
  userSessionCounts: {},
  requestedCallIds: new Set(),
  callsHydrated: false,
  liveCallStartedAt: null,
  isMuted: false,
  isOnHold: false
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
const resetDataBtn = document.getElementById("resetDataBtn");
const lastRefresh = document.getElementById("lastRefresh");
const sessionSearch = document.getElementById("sessionSearch");
const incomingBadge = document.getElementById("incomingBadge");
const voiceStatusBadge = document.getElementById("voiceStatusBadge");
const liveCallCard = document.getElementById("liveCallCard");
const liveCallAvatar = document.getElementById("liveCallAvatar");
const liveCallTitle = document.getElementById("liveCallTitle");
const liveCallMeta = document.getElementById("liveCallMeta");
const liveCallTimer = document.getElementById("liveCallTimer");
const answerCallBtn = document.getElementById("answerCallBtn");
const endCallBtn = document.getElementById("endCallBtn");
const muteCallBtn = document.getElementById("muteCallBtn");
const holdCallBtn = document.getElementById("holdCallBtn");

let audioContext;
let titlePulseInterval;
let liveTimerInterval;
const baseDocumentTitle = document.title;
let device = null;
let activeVoiceCall = null;
let incomingVoiceCall = null;
const callMeta = new WeakMap();

const COMPLETED_CALL_STATUSES = new Set(["completed"]);
const MISSED_CALL_STATUSES = new Set(["failed", "cancelled", "missed", "no_answer", "busy", "rejected"]);

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

const requestIdFromCall = (call) => {
  const custom = call?.customParameters;
  const requestId = custom?.get ? custom.get("requestId") : null;
  return requestId || null;
};

const updateCallStatusQuietly = async (callId, status) => {
  if (!callId) return;
  try {
    await api(`/calls/${callId}/status`, {
      method: "POST",
      body: JSON.stringify({ status })
    });
  } catch (error) {
    console.warn(`Failed to update call ${callId} to ${status}:`, error?.message || error);
  }
};

const getInitials = (value) =>
  String(value || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || "")
    .join("")
    .toUpperCase() || "SN";

const isCallHistoryEntry = (call) => {
  const status = String(call.status || "").toLowerCase();
  return COMPLETED_CALL_STATUSES.has(status) || MISSED_CALL_STATUSES.has(status);
};

const getCallOutcomeLabel = (call) => {
  const status = String(call.status || "").toLowerCase();
  if (COMPLETED_CALL_STATUSES.has(status)) return "Completed";
  if (MISSED_CALL_STATUSES.has(status)) return "Missed";
  return "Other";
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

const formatDuration = (seconds) => {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
};

const stopLiveTimer = () => {
  if (liveTimerInterval) {
    clearInterval(liveTimerInterval);
    liveTimerInterval = null;
  }
};

const startLiveTimer = () => {
  stopLiveTimer();
  state.liveCallStartedAt = Date.now();
  liveCallTimer.textContent = "00:00";
  liveTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - state.liveCallStartedAt) / 1000);
    liveCallTimer.textContent = formatDuration(elapsed);
  }, 1000);
};

const setLiveCallUI = ({
  title,
  meta,
  caller = "Symptom Nerd",
  open = false,
  ringing = false,
  canAnswer = false,
  canReject = false,
  canHangup = false,
  canMute = false,
  canHold = false
}) => {
  liveCallTitle.textContent = title;
  liveCallMeta.textContent = meta;
  liveCallAvatar.textContent = getInitials(caller);
  liveCallCard.classList.toggle("open", open);
  liveCallCard.classList.toggle("ringing", ringing);
  const canEndCall = canReject || canHangup;
  answerCallBtn.disabled = !canAnswer;
  endCallBtn.disabled = !canEndCall;
  muteCallBtn.disabled = !canMute;
  holdCallBtn.disabled = !canHold;
  endCallBtn.textContent = "End call";
  if (!canEndCall) {
    stopLiveTimer();
    liveCallTimer.textContent = "00:00";
    state.liveCallStartedAt = null;
    state.isMuted = false;
    state.isOnHold = false;
    muteCallBtn.textContent = "Mute";
    holdCallBtn.textContent = "Hold";
  }
  muteCallBtn.classList.toggle("active", state.isMuted);
  holdCallBtn.classList.toggle("active", state.isOnHold);
};

const callerLabelFromCall = (call) => {
  const custom = call.customParameters;
  const callerName = custom?.get ? custom.get("callerName") : null;
  const callerIdentity = custom?.get ? custom.get("callerIdentity") : null;
  return callerName || callerIdentity || call.parameters?.From || "Unknown caller";
};

const wireCallLifecycle = (call, options = {}) => {
  const meta = {
    requestId: options.requestId || requestIdFromCall(call),
    wasConnected: false
  };
  callMeta.set(call, meta);

  call.on("ringing", () => {
    const current = callMeta.get(call) || meta;
    if (current.requestId) {
      void updateCallStatusQuietly(current.requestId, "ringing");
    }
  });

  call.on("accept", () => {
    const current = callMeta.get(call) || meta;
    current.wasConnected = true;
    callMeta.set(call, current);
    activeVoiceCall = call;
    incomingVoiceCall = null;
    state.isOnHold = false;
    state.isMuted = false;
    muteCallBtn.textContent = "Mute";
    holdCallBtn.textContent = "Hold";
    startLiveTimer();
    stopTitlePulse();
    setVoiceBadge("Live connected", "incoming");
    setLiveCallUI({
      title: "Live call connected",
      meta: `Talking to ${callerLabelFromCall(call)}`,
      caller: callerLabelFromCall(call),
      open: true,
      ringing: false,
      canAnswer: false,
      canReject: false,
      canHangup: true,
      canMute: true,
      canHold: true
    });
    if (current.requestId) {
      void updateCallStatusQuietly(current.requestId, "in_progress");
    }
  });

  call.on("disconnect", () => {
    const current = callMeta.get(call) || meta;
    activeVoiceCall = null;
    incomingVoiceCall = null;
    stopLiveTimer();
    stopTitlePulse();
    setVoiceBadge("Voice online", "");
    setLiveCallUI({
      title: "No active live call",
      meta: "Waiting for incoming pharmacist calls from users.",
      open: false,
      ringing: false,
      canAnswer: false,
      canReject: false,
      canHangup: false,
      canMute: false,
      canHold: false
    });
    if (current.requestId) {
      void updateCallStatusQuietly(current.requestId, current.wasConnected ? "completed" : "missed");
    }
    refreshIncomingBadge();
  });

  call.on("cancel", () => {
    const current = callMeta.get(call) || meta;
    incomingVoiceCall = null;
    stopLiveTimer();
    stopTitlePulse();
    setVoiceBadge("Voice online", "");
    setLiveCallUI({
      title: "Missed incoming call",
      meta: "Caller hung up before answer.",
      open: false,
      ringing: false,
      canAnswer: false,
      canReject: false,
      canHangup: false,
      canMute: false,
      canHold: false
    });
    if (current.requestId) {
      void updateCallStatusQuietly(current.requestId, "missed");
    }
    refreshIncomingBadge();
  });

  call.on("reject", () => {
    const current = callMeta.get(call) || meta;
    incomingVoiceCall = null;
    stopLiveTimer();
    stopTitlePulse();
    setVoiceBadge("Voice online", "");
    if (current.requestId) {
      void updateCallStatusQuietly(current.requestId, "missed");
    }
  });

  call.on("error", (error) => {
    const current = callMeta.get(call) || meta;
    console.error("Twilio call error:", error);
    stopLiveTimer();
    setVoiceBadge("Voice error", "danger");
    setLiveCallUI({
      title: "Voice call error",
      meta: error?.message || "Unknown call error.",
      open: false,
      ringing: false,
      canAnswer: false,
      canReject: false,
      canHangup: false,
      canMute: false,
      canHold: false
    });
    if (current.requestId) {
      void updateCallStatusQuietly(current.requestId, "failed");
    }
  });
};

const startCallbackCall = async (call) => {
  if (!device) {
    alert("Voice line is not ready yet.");
    return;
  }
  if (activeVoiceCall || incomingVoiceCall) {
    alert("Finish the current call first.");
    return;
  }
  const identity = String(call.identity || "").trim();
  if (!identity) {
    alert("Callback is unavailable for this call (missing caller identity).");
    return;
  }

  const caller = userNameForCall(call);
  setVoiceBadge("Calling back", "incoming");
  setLiveCallUI({
    title: "Calling back",
    meta: `Dialing ${caller}…`,
    caller,
    open: true,
    ringing: false,
    canAnswer: false,
    canReject: false,
    canHangup: true,
    canMute: false,
    canHold: false
  });

  try {
    const callbackCall = await device.connect({
      params: {
        To: identity,
        RequestID: call.id,
        CallerName: "Pharmacist"
      }
    });
    activeVoiceCall = callbackCall;
    wireCallLifecycle(callbackCall, { requestId: call.id });
    await updateCallStatusQuietly(call.id, "ringing");
  } catch (error) {
    console.error("Callback attempt failed:", error);
    setVoiceBadge("Callback failed", "danger");
    setLiveCallUI({
      title: "Callback failed",
      meta: error?.message || "Could not place callback.",
      caller,
      open: false,
      ringing: false,
      canAnswer: false,
      canReject: false,
      canHangup: false,
      canMute: false,
      canHold: false
    });
    await updateCallStatusQuietly(call.id, "failed");
  }
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
      open: false,
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
        open: false,
        ringing: false,
        canAnswer: false,
        canReject: false,
        canHangup: false
      });
    });

    device.on("incoming", (call) => {
      incomingVoiceCall = call;
      const requestId = requestIdFromCall(call);
      wireCallLifecycle(call, { requestId });
      if (requestId) {
        void updateCallStatusQuietly(requestId, "ringing");
      }
      const caller = callerLabelFromCall(call);
      setVoiceBadge("Incoming live call", "incoming");
      setLiveCallUI({
        title: "Incoming live call",
        meta: `Caller: ${caller}`,
        caller,
        open: true,
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
        open: false,
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
      open: false,
      ringing: false,
      canAnswer: false,
      canReject: false,
      canHangup: false
    });
  }
};

const refreshIncomingBadge = () => {
  const requestedCount = state.calls.filter((call) => ["requested", "queued", "ringing"].includes(call.status)).length;
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
  const filtered = state.calls
    .filter((call) => isCallHistoryEntry(call))
    .sort((left, right) => {
      const leftTime = new Date(left.endedAt || left.updatedAt || left.createdAt || 0).getTime();
      const rightTime = new Date(right.endedAt || right.updatedAt || right.createdAt || 0).getTime();
      return rightTime - leftTime;
    });

  callsList.innerHTML = "";
  if (!filtered.length) {
    const li = document.createElement("li");
    li.className = "list-item";
    li.innerHTML = `
      <div class="title">No completed or missed calls yet</div>
      <div class="meta">Live incoming calls appear in the full-screen caller interface.</div>
    `;
    callsList.appendChild(li);
    return;
  }

  filtered.forEach((call) => {
    const li = document.createElement("li");
    li.className = "list-item";
    const caller = userNameForCall(call);
    const outcome = getCallOutcomeLabel(call);
    const completedAt = formatTime(call.endedAt || call.updatedAt || call.createdAt);
    const hasCallback = outcome === "Missed" && Boolean(call.identity);
    li.innerHTML = `
      <div class="title">${caller}<span class="pill ${outcome === "Completed" ? "returning" : "requested"}">${outcome}</span></div>
      <div class="meta">${short(call.handoff?.userMessage || "Call request")}</div>
      <div class="meta">${outcome} • ${completedAt}</div>
      ${hasCallback ? '<button class="history-cta" data-action="callback">Call back</button>' : ""}
    `;
    if (hasCallback) {
      li.querySelector('[data-action="callback"]')?.addEventListener("click", () => {
        void startCallbackCall(call);
      });
    }
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
  if (!state.activeSessionId && state.sessions.length) {
    await setActiveSession(state.sessions[0].id);
  }
};

const loadMessages = async (sessionId) => {
  const data = await api(`/sessions/${sessionId}/messages`);
  renderMessages(data.messages || []);
};

const loadCalls = async () => {
  const data = await api("/calls");
  state.calls = data.calls || [];

  const currentRequested = new Set(
    state.calls.filter((call) => ["requested", "queued", "ringing"].includes(call.status)).map((call) => call.id)
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

const refreshAll = async () => {
  const issues = [];

  await Promise.all([
    loadSessions().catch((error) => {
      issues.push(`sessions: ${error?.message || "failed"}`);
    }),
    loadCalls().catch((error) => {
      issues.push(`calls: ${error?.message || "failed"}`);
    }),
    sendPresenceHeartbeat().catch((error) => {
      issues.push(`presence: ${error?.message || "failed"}`);
    })
  ]);

  if (state.activeSessionId) {
    await loadMessages(state.activeSessionId).catch((error) => {
      issues.push(`messages: ${error?.message || "failed"}`);
    });
  }

  if (issues.length) {
    lastRefresh.textContent = `Last refresh: ${new Date().toLocaleTimeString()} (issues: ${issues.join("; ")})`;
    console.warn("Refresh issues:", issues.join(" | "));
  } else {
    lastRefresh.textContent = `Last refresh: ${new Date().toLocaleTimeString()}`;
  }
};

const sendPresenceHeartbeat = async () => {
  try {
    await api("/presence/heartbeat", { method: "POST", body: "{}" });
  } catch (error) {
    console.warn("Presence heartbeat failed:", error?.message || error);
  }
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

endCallBtn.addEventListener("click", () => {
  if (incomingVoiceCall) {
    const requestId = requestIdFromCall(incomingVoiceCall);
    incomingVoiceCall.reject();
    incomingVoiceCall = null;
    setVoiceBadge("Voice online", "");
    setLiveCallUI({
      title: "Call ended",
      meta: "Waiting for incoming pharmacist calls from users.",
      open: false,
      ringing: false,
      canAnswer: false,
      canReject: false,
      canHangup: false
    });
    if (requestId) {
      void updateCallStatusQuietly(requestId, "missed");
    }
    refreshIncomingBadge();
    return;
  }

  if (activeVoiceCall) {
    activeVoiceCall.disconnect();
  }
});

muteCallBtn.addEventListener("click", () => {
  if (!activeVoiceCall) return;
  state.isMuted = !state.isMuted;
  activeVoiceCall.mute(state.isMuted);
  muteCallBtn.classList.toggle("active", state.isMuted);
  muteCallBtn.textContent = state.isMuted ? "Unmute" : "Mute";
});

holdCallBtn.addEventListener("click", () => {
  if (!activeVoiceCall) return;
  state.isOnHold = !state.isOnHold;
  activeVoiceCall.mute(state.isOnHold);
  holdCallBtn.classList.toggle("active", state.isOnHold);
  holdCallBtn.textContent = state.isOnHold ? "Resume" : "Hold";
});

resetDataBtn.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "This deletes all chat sessions, messages, and call history for every user. Continue?"
  );
  if (!confirmed) return;
  resetDataBtn.disabled = true;
  try {
    await api("/admin/reset", { method: "POST", body: "{}" });
    state.activeSessionId = null;
    sessionTitle.textContent = "Select a chat";
    sessionSubtitle.textContent = "Messages will appear here.";
    messagesEl.innerHTML = "";
    await refreshAll();
    alert("All pharmacist data has been cleared.");
  } catch (error) {
    alert(error?.message || "Failed to clear data.");
  } finally {
    resetDataBtn.disabled = false;
  }
});

refreshBtn.addEventListener("click", refreshAll);
sessionSearch.addEventListener("input", renderSessions);

setVoiceBadge("Starting voice line…", "");
setLiveCallUI({
  title: "Live call line is starting…",
  meta: "Fetching Twilio token and registering browser device.",
  open: false,
  ringing: false,
  canAnswer: false,
  canReject: false,
  canHangup: false
});

setupVoiceDevice();
refreshAll();
api("/diagnostics")
  .then((data) => {
    console.log("Pharmacist diagnostics:", data);
  })
  .catch((error) => {
    console.warn("Diagnostics unavailable:", error?.message || error);
  });
setInterval(refreshAll, 5000);
