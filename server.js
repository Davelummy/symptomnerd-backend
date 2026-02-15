import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pg from "pg";
import admin from "firebase-admin";
import twilio from "twilio";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

const PORT = process.env.PORT || 3001;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const AI_PROVIDER = process.env.AI_PROVIDER || (GEMINI_API_KEY ? "gemini" : "openai");
const NEON_DATABASE_URL = process.env.NEON_DATABASE_URL;
const LOG_AI_REQUESTS = process.env.LOG_AI_REQUESTS === "true";
const PHARMACIST_USER = process.env.PHARMACIST_USER;
const PHARMACIST_PASS = process.env.PHARMACIST_PASS;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_API_KEY = process.env.TWILIO_API_KEY;
const TWILIO_API_SECRET = process.env.TWILIO_API_SECRET;
const TWILIO_TWIML_APP_SID = process.env.TWILIO_TWIML_APP_SID;
const TWILIO_PHARMACIST_IDENTITY = process.env.TWILIO_PHARMACIST_IDENTITY || "pharmacist_console";

const { AccessToken } = twilio.jwt;
const { VoiceGrant } = AccessToken;

let pool;
let dbInitPromise;
let firestore;
let firebaseReady = false;

function initFirebaseAdmin() {
  if (firebaseReady) return true;
  if (admin.apps.length) {
    firestore = admin.firestore();
    firebaseReady = true;
    return true;
  }

  try {
    const serviceAccountJSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (serviceAccountJSON) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(serviceAccountJSON))
      });
    } else {
      admin.initializeApp();
    }
    firestore = admin.firestore();
    firebaseReady = true;
    return true;
  } catch (err) {
    console.warn("Firebase Admin not configured:", err?.message || err);
    firebaseReady = false;
    return false;
  }
}

if (!OPENAI_API_KEY && AI_PROVIDER === "openai") {
  console.warn("Missing OPENAI_API_KEY. Set it in .env before calling /ai endpoints.");
}

if (!GEMINI_API_KEY && AI_PROVIDER === "gemini") {
  console.warn("Missing GEMINI_API_KEY (or GOOGLE_API_KEY). Set it in .env before calling /ai endpoints.");
}

if (LOG_AI_REQUESTS && !NEON_DATABASE_URL) {
  console.warn("LOG_AI_REQUESTS=true but NEON_DATABASE_URL is missing. Skipping DB logging.");
}

if (!PHARMACIST_USER || !PHARMACIST_PASS) {
  console.warn("Missing PHARMACIST_USER/PHARMACIST_PASS. Pharmacist console will be locked.");
}

if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY || !TWILIO_API_SECRET || !TWILIO_TWIML_APP_SID) {
  console.warn("Twilio Voice is not fully configured. Live in-app calls will be disabled.");
}

const responseSchema = {
  type: "object",
  properties: {
    recap: { type: "string" },
    patterns: { type: "array", items: { type: "string" } },
    suggestions: { type: "array", items: { type: "string" } },
    redFlags: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          whyItMatters: { type: "string" },
          action: { type: "string" }
        },
        required: ["title", "whyItMatters", "action"]
      }
    },
    questionsForClinician: { type: "array", items: { type: "string" } },
    disclaimer: { type: "string" }
  },
  required: ["recap", "patterns", "suggestions", "redFlags", "questionsForClinician", "disclaimer"]
};

const geminiResponseSchema = {
  type: "object",
  properties: {
    recap: { type: "string" },
    patterns: { type: "array", items: { type: "string" } },
    suggestions: { type: "array", items: { type: "string" } },
    redFlags: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          whyItMatters: { type: "string" },
          action: { type: "string" }
        },
        required: ["title", "whyItMatters", "action"]
      }
    },
    questionsForClinician: { type: "array", items: { type: "string" } },
    disclaimer: { type: "string" }
  },
  required: ["recap", "patterns", "suggestions", "redFlags", "questionsForClinician", "disclaimer"]
};

const systemPrompt = `You are Symptom Nerd AI, a structured symptom-pattern assistant.\n- You are informational only: do not diagnose, prescribe, or claim certainty.\n- Always analyze all shared logs jointly across the timeframe before answering.\n- Use medicalContext (allergies, chronic conditions, medications, surgeries, family history, notes, recent health history) as key context for interpretation.\n- Weigh current symptom logs with medical profile/history together, and call out when historical context may influence possible explanations or risk.\n- Acknowledge the user's concern directly and reference symptom trends, severity, triggers, and timing from logs.\n- Suggest a wide range of plausible, non-diagnostic possibilities and practical next-step options.\n- If medication names are present, include interaction-safety cautions and recommend pharmacist review for interaction checks.\n- Ask targeted follow-up questions in "questionsForClinician" whenever uncertainty remains.\n- If risk is elevated, uncertainty remains high, or symptoms persist/worsen, explicitly recommend pharmacist chat/call.\n- Include emergency guidance when relevant: "If you think this may be an emergency, call your local emergency number."\n- Respect preferred language if provided in payload.\n- Output must strictly match the JSON schema.\n- Keep tone calm, clear, and non-alarming.`;

function getPool() {
  if (!LOG_AI_REQUESTS || !NEON_DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: NEON_DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
  }
  return pool;
}

function requirePharmacistAuth(req, res, next) {
  if (!PHARMACIST_USER || !PHARMACIST_PASS) {
    return res.status(500).json({ error: "Pharmacist console not configured." });
  }
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", "Basic");
    return res.status(401).send("Authentication required.");
  }
  const base64 = header.replace("Basic ", "");
  const decoded = Buffer.from(base64, "base64").toString("utf8");
  const [user, pass] = decoded.split(":");
  if (user !== PHARMACIST_USER || pass !== PHARMACIST_PASS) {
    return res.status(403).send("Invalid credentials.");
  }
  return next();
}

function ensureFirebase(req, res, next) {
  if (!firestore || !firebaseReady) {
    const ok = initFirebaseAdmin();
    if (!ok) {
      return res.status(500).json({ error: "Firebase Admin not configured." });
    }
  }
  return next();
}

function serializeValue(value) {
  if (!value) return value;
  if (typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item));
  }
  if (typeof value === "object") {
    const nested = {};
    for (const [key, item] of Object.entries(value)) {
      nested[key] = serializeValue(item);
    }
    return nested;
  }
  return value;
}

function serializeDoc(doc) {
  const data = doc.data() || {};
  return { id: doc.id, ...serializeValue(data) };
}

function isFirestoreQuotaExceeded(err) {
  const message = String(err?.message || "").toLowerCase();
  return (
    err?.code === 8 ||
    err?.code === "resource-exhausted" ||
    message.includes("resource_exhausted") ||
    message.includes("quota exceeded")
  );
}

function buildDirectTwilioCallPayload(user, message = null) {
  return {
    queued: false,
    requestId: null,
    queuePosition: 1,
    token: createTwilioVoiceToken(user.identity),
    identity: user.identity,
    displayName: user.callerName,
    pharmacistIdentity: sanitizeIdentity(TWILIO_PHARMACIST_IDENTITY, "pharmacist_console"),
    degraded: true,
    message: message || "Connected directly because queue service is temporarily unavailable."
  };
}

function isTwilioConfigured() {
  return Boolean(TWILIO_ACCOUNT_SID && TWILIO_API_KEY && TWILIO_API_SECRET && TWILIO_TWIML_APP_SID);
}

function sanitizeIdentity(identity, fallback = "") {
  const cleaned = String(identity || "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 120);
  return cleaned || fallback;
}

function createTwilioVoiceToken(identity) {
  const token = new AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, {
    identity
  });
  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: TWILIO_TWIML_APP_SID,
    incomingAllow: true
  });
  token.addGrant(voiceGrant);
  return token.toJwt();
}

function extractBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

const CALLS_COLLECTION = "pharmacist_call_requests";
const PRESENCE_COLLECTION = "pharmacist_presence";
const ACTIVE_CALL_STATUSES = ["requested", "queued", "ringing", "in_progress"];
const TERMINAL_CALL_STATUSES = new Set(["completed", "failed", "cancelled", "missed"]);
const USER_UPDATABLE_CALL_STATUSES = new Set(["ringing", "in_progress", "completed", "failed", "cancelled", "missed"]);

function parseCallerNameParts(fullName) {
  const pieces = String(fullName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!pieces.length) {
    return { firstName: "User", lastName: "" };
  }
  return {
    firstName: pieces[0],
    lastName: pieces.slice(1).join(" ")
  };
}

function resolveCallerName(decoded) {
  const fromToken = [decoded?.given_name, decoded?.family_name].filter(Boolean).join(" ").trim();
  if (fromToken) return fromToken.slice(0, 80);
  const display = String(decoded?.name || "").trim();
  if (display) return display.slice(0, 80);
  const email = String(decoded?.email || "").trim();
  if (email.includes("@")) return email.split("@")[0].slice(0, 80);
  return `User ${String(decoded?.uid || "unknown").slice(0, 6)}`;
}

async function verifyFirebaseUserFromRequest(req) {
  const idToken = extractBearerToken(req);
  if (!idToken) {
    const error = new Error("Missing Firebase ID token.");
    error.statusCode = 401;
    throw error;
  }
  const decoded = await admin.auth().verifyIdToken(idToken);
  const uid = decoded.uid;
  const identity = sanitizeIdentity(`user_${uid}`, `user_${Date.now()}`);
  const callerName = resolveCallerName(decoded);
  const { firstName, lastName } = parseCallerNameParts(callerName);
  return {
    decoded,
    uid,
    identity,
    callerName,
    firstName,
    lastName,
    userEmail: decoded.email || ""
  };
}

function callCreatedAtMillis(doc) {
  const createdAt = doc.data()?.createdAt;
  if (createdAt && typeof createdAt.toMillis === "function") {
    return createdAt.toMillis();
  }
  return 0;
}

async function listActiveCalls() {
  const snapshot = await firestore
    .collection(CALLS_COLLECTION)
    .where("status", "in", ACTIVE_CALL_STATUSES)
    .get();
  return snapshot.docs.sort((left, right) => callCreatedAtMillis(left) - callCreatedAtMillis(right));
}

async function rebalanceCallQueue() {
  const docs = await listActiveCalls();
  if (!docs.length) return;

  const batch = firestore.batch();
  let hasUpdates = false;

  docs.forEach((doc, index) => {
    const data = doc.data() || {};
    const queuePosition = index + 1;
    const updates = {};

    if (data.queuePosition !== queuePosition) {
      updates.queuePosition = queuePosition;
    }

    if (queuePosition === 1 && data.status === "queued") {
      updates.status = "requested";
    }

    if (Object.keys(updates).length) {
      updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
      batch.update(doc.ref, updates);
      hasUpdates = true;
    }
  });

  if (hasUpdates) {
    await batch.commit();
  }
}

async function deleteCollectionDocs(collectionRef) {
  const snapshot = await collectionRef.get();
  if (snapshot.empty) return 0;
  const batch = firestore.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  return snapshot.size;
}

async function resetPharmacistData() {
  const sessionsSnapshot = await firestore.collection("pharmacist_sessions").get();
  let deletedMessages = 0;
  const sessionBatch = firestore.batch();

  for (const sessionDoc of sessionsSnapshot.docs) {
    deletedMessages += await deleteCollectionDocs(sessionDoc.ref.collection("messages"));
    sessionBatch.delete(sessionDoc.ref);
  }

  if (!sessionsSnapshot.empty) {
    await sessionBatch.commit();
  }

  const callsSnapshot = await firestore.collection(CALLS_COLLECTION).get();
  const callsBatch = firestore.batch();
  callsSnapshot.docs.forEach((doc) => callsBatch.delete(doc.ref));
  if (!callsSnapshot.empty) {
    await callsBatch.commit();
  }

  const presenceSnapshot = await firestore.collection(PRESENCE_COLLECTION).get();
  const presenceBatch = firestore.batch();
  presenceSnapshot.docs.forEach((doc) => presenceBatch.delete(doc.ref));
  if (!presenceSnapshot.empty) {
    await presenceBatch.commit();
  }

  if (LOG_AI_REQUESTS) {
    const sqlPool = getPool();
    if (sqlPool) {
      await ensureDb();
      await sqlPool.query("TRUNCATE TABLE ai_requests;");
    }
  }

  return {
    deletedSessions: sessionsSnapshot.size,
    deletedMessages,
    deletedCalls: callsSnapshot.size,
    deletedPresenceDocs: presenceSnapshot.size
  };
}

app.use("/pharmacist", requirePharmacistAuth, express.static(publicDir));
app.get("/pharmacist", requirePharmacistAuth, (req, res) => {
  res.sendFile(path.join(publicDir, "pharmacist.html"));
});

app.use("/pharmacist/api", requirePharmacistAuth, ensureFirebase);

app.get("/pharmacist/api/sessions", async (req, res) => {
  try {
    const snapshot = await firestore
      .collection("pharmacist_sessions")
      .orderBy("updatedAt", "desc")
      .limit(50)
      .get();
    const sessions = snapshot.docs.map(serializeDoc);
    res.json({ sessions });
  } catch (err) {
    if (isFirestoreQuotaExceeded(err)) {
      return res.status(429).json({
        error:
          "Firestore quota exceeded. Open Firebase Billing to upgrade, or wait for quota reset (daily reset around midnight Pacific)."
      });
    }
    res.status(500).json({ error: err?.message || "Failed to load sessions." });
  }
});

app.get("/pharmacist/api/sessions/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    const snapshot = await firestore
      .collection("pharmacist_sessions")
      .doc(id)
      .collection("messages")
      .orderBy("createdAt", "asc")
      .get();
    const messages = snapshot.docs.map(serializeDoc);
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Failed to load messages." });
  }
});

app.post("/pharmacist/api/sessions/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    const content = (req.body?.content || "").trim();
    if (!content) {
      return res.status(400).json({ error: "Message content is required." });
    }
    const messageId = firestore.collection("noop").doc().id;
    const message = {
      id: messageId,
      role: "pharmacist",
      content,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const sessionRef = firestore.collection("pharmacist_sessions").doc(id);
    await sessionRef.collection("messages").doc(messageId).set(message);
    await sessionRef.update({
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      statusText: "Pharmacist replied"
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Failed to send message." });
  }
});

app.post("/pharmacist/api/sessions/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const statusText = req.body?.statusText || null;
    const queuePosition = req.body?.queuePosition ?? null;
    await firestore.collection("pharmacist_sessions").doc(id).update({
      statusText,
      queuePosition,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Failed to update status." });
  }
});

app.get("/pharmacist/api/calls", async (req, res) => {
  try {
    const snapshot = await firestore
      .collection(CALLS_COLLECTION)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();
    const calls = snapshot.docs.map(serializeDoc);
    res.json({ calls });
  } catch (err) {
    if (isFirestoreQuotaExceeded(err)) {
      return res.status(429).json({
        error:
          "Firestore quota exceeded. Open Firebase Billing to upgrade, or wait for quota reset (daily reset around midnight Pacific)."
      });
    }
    res.status(500).json({ error: err?.message || "Failed to load calls." });
  }
});

app.get("/pharmacist/api/diagnostics", async (_req, res) => {
  try {
    const appRef = admin.app();
    const options = appRef.options || {};
    const projectId = options.projectId || process.env.GCLOUD_PROJECT || null;
    const sessionsCount = (await firestore.collection("pharmacist_sessions").limit(300).get()).size;
    const callsCount = (await firestore.collection(CALLS_COLLECTION).limit(300).get()).size;
    res.json({
      ok: true,
      projectId,
      sessionsCount,
      callsCount
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Failed to load diagnostics." });
  }
});

app.post("/pharmacist/api/calls/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const status = req.body?.status || "in_progress";
    const update = {
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (status === "in_progress") {
      update.startedAt = admin.firestore.FieldValue.serverTimestamp();
    }
    if (TERMINAL_CALL_STATUSES.has(status)) {
      update.endedAt = admin.firestore.FieldValue.serverTimestamp();
      update.queuePosition = null;
    }
    await firestore.collection(CALLS_COLLECTION).doc(id).update(update);
    await rebalanceCallQueue();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Failed to update call status." });
  }
});

app.post("/pharmacist/api/admin/reset", async (_req, res) => {
  try {
    const result = await resetPharmacistData();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Failed to reset pharmacist data." });
  }
});

app.post("/pharmacist/api/presence/heartbeat", async (_req, res) => {
  try {
    await firestore.collection(PRESENCE_COLLECTION).doc("console").set(
      {
        id: "console",
        isOnline: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Failed to update presence." });
  }
});

app.post("/pharmacist/api/twilio/token", async (_req, res) => {
  try {
    if (!isTwilioConfigured()) {
      return res.status(500).json({ error: "Twilio Voice not configured." });
    }
    const identity = sanitizeIdentity(TWILIO_PHARMACIST_IDENTITY, "pharmacist_console");
    const token = createTwilioVoiceToken(identity);
    return res.json({ token, identity });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Failed to create Twilio token." });
  }
});

app.post("/twilio/access-token", ensureFirebase, async (req, res) => {
  try {
    if (!isTwilioConfigured()) {
      return res.status(500).json({ error: "Twilio Voice not configured." });
    }
    const user = await verifyFirebaseUserFromRequest(req);
    const token = createTwilioVoiceToken(user.identity);
    return res.json({
      token,
      identity: user.identity,
      displayName: user.callerName,
      pharmacistIdentity: sanitizeIdentity(TWILIO_PHARMACIST_IDENTITY, "pharmacist_console")
    });
  } catch (err) {
    const statusCode = err?.statusCode || 401;
    return res.status(statusCode).json({ error: err?.message || "Invalid Firebase ID token." });
  }
});

app.post("/twilio/start-call", ensureFirebase, async (req, res) => {
  try {
    const user = await verifyFirebaseUserFromRequest(req);
    const now = admin.firestore.FieldValue.serverTimestamp();

    if (!isTwilioConfigured()) {
      return res.status(503).json({
        error: "Twilio Voice not configured."
      });
    }

    await rebalanceCallQueue();
    let activeCalls = await listActiveCalls();
    let existingCall = activeCalls.find((doc) => doc.data()?.userId === user.uid);
    let queuePosition = 1;
    let callRef;

    if (existingCall) {
      callRef = existingCall.ref;
      queuePosition =
        existingCall.data()?.queuePosition ||
        Math.max(
          1,
          activeCalls.findIndex((doc) => doc.id === existingCall.id) + 1
        );
    } else {
      callRef = firestore.collection(CALLS_COLLECTION).doc();
      const handoff = req.body?.handoff || {};
      queuePosition = activeCalls.length + 1;
      const initialStatus = queuePosition <= 1 ? "requested" : "queued";
      await callRef.set({
        id: callRef.id,
        userId: user.uid,
        callerName: user.callerName,
        callerFirstName: user.firstName,
        callerLastName: user.lastName,
        userDisplayName: user.callerName,
        userEmail: user.userEmail,
        identity: user.identity,
        handoff: {
          userMessage: String(handoff.userMessage || "").slice(0, 500),
          summarizedLogs: String(handoff.summarizedLogs || "").slice(0, 4000),
          attachedRange: handoff.attachedRange || null
        },
        status: initialStatus,
        queuePosition,
        createdAt: now,
        updatedAt: now
      });
      await rebalanceCallQueue();
      const refreshed = await callRef.get();
      queuePosition = refreshed.data()?.queuePosition || queuePosition;
    }

    if (queuePosition > 1) {
      return res.json({
        queued: true,
        requestId: callRef.id,
        queuePosition,
        message: `All pharmacists are on active calls. You are #${queuePosition} in queue.`
      });
    }

    const token = createTwilioVoiceToken(user.identity);
    return res.json({
      queued: false,
      requestId: callRef.id,
      queuePosition: 1,
      token,
      identity: user.identity,
      displayName: user.callerName,
      pharmacistIdentity: sanitizeIdentity(TWILIO_PHARMACIST_IDENTITY, "pharmacist_console")
    });
  } catch (err) {
    if (isFirestoreQuotaExceeded(err)) {
      try {
        const user = await verifyFirebaseUserFromRequest(req);
        if (isTwilioConfigured()) {
          return res.json(
            buildDirectTwilioCallPayload(
              user,
              "Queue service is temporarily unavailable. We are connecting you directly."
            )
          );
        }
      } catch {
        // Fall through to standard error response.
      }
      return res.status(429).json({
        error:
          "Live call queue is unavailable because Firestore quota is exceeded. Direct Twilio connection is also unavailable."
      });
    }
    const statusCode = err?.statusCode || 500;
    return res.status(statusCode).json({ error: err?.message || "Unable to start call." });
  }
});

app.post("/twilio/calls/:id/status", ensureFirebase, async (req, res) => {
  try {
    const user = await verifyFirebaseUserFromRequest(req);
    const { id } = req.params;
    const status = String(req.body?.status || "").trim();
    if (!USER_UPDATABLE_CALL_STATUSES.has(status)) {
      return res.status(400).json({ error: "Invalid call status." });
    }

    const callRef = firestore.collection(CALLS_COLLECTION).doc(id);
    const snapshot = await callRef.get();
    if (!snapshot.exists) {
      return res.status(404).json({ error: "Call request not found." });
    }

    const current = snapshot.data() || {};
    if (current.userId !== user.uid) {
      return res.status(403).json({ error: "You cannot update this call request." });
    }

    const update = {
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (status === "in_progress") {
      update.startedAt = current.startedAt || admin.firestore.FieldValue.serverTimestamp();
      update.queuePosition = 1;
    }
    if (TERMINAL_CALL_STATUSES.has(status)) {
      update.endedAt = admin.firestore.FieldValue.serverTimestamp();
      update.queuePosition = null;
    }

    await callRef.update(update);
    await rebalanceCallQueue();
    return res.json({ ok: true });
  } catch (err) {
    const statusCode = err?.statusCode || 500;
    return res.status(statusCode).json({ error: err?.message || "Unable to update call status." });
  }
});

app.get("/twilio/calls/:id", ensureFirebase, async (req, res) => {
  try {
    const user = await verifyFirebaseUserFromRequest(req);
    const { id } = req.params;
    const snapshot = await firestore.collection(CALLS_COLLECTION).doc(id).get();
    if (!snapshot.exists) {
      return res.status(404).json({ error: "Call request not found." });
    }
    const data = snapshot.data() || {};
    if (data.userId !== user.uid) {
      return res.status(403).json({ error: "You cannot access this call request." });
    }
    return res.json({ call: serializeDoc(snapshot) });
  } catch (err) {
    const statusCode = err?.statusCode || 500;
    return res.status(statusCode).json({ error: err?.message || "Unable to load call request." });
  }
});

app.post("/twilio/voice", express.urlencoded({ extended: false }), (req, res) => {
  if (!isTwilioConfigured()) {
    return res.status(500).type("text/plain").send("Twilio Voice is not configured.");
  }

  const requestedTo = sanitizeIdentity(req.body?.To || req.query?.to, "");
  const callerIdentity = sanitizeIdentity(req.body?.From || req.body?.Caller || "", "");
  const requestId = String(req.body?.RequestID || req.body?.requestId || "")
    .trim()
    .slice(0, 120);
  const callerName = String(req.body?.CallerName || req.body?.callerName || "")
    .trim()
    .slice(0, 80);
  const targetIdentity = requestedTo || sanitizeIdentity(TWILIO_PHARMACIST_IDENTITY, "pharmacist_console");

  const twiml = new twilio.twiml.VoiceResponse();
  const dial = twiml.dial({
    answerOnBridge: true
  });
  const client = dial.client();
  client.identity(targetIdentity);

  if (callerName) {
    client.parameter({ name: "callerName", value: callerName });
  }
  if (callerIdentity) {
    client.parameter({ name: "callerIdentity", value: callerIdentity });
  }
  if (requestId) {
    client.parameter({ name: "requestId", value: requestId });
  }

  return res.type("text/xml").send(twiml.toString());
});

app.get("/pharmacist-presence", ensureFirebase, async (_req, res) => {
  try {
    const presenceDoc = await firestore.collection(PRESENCE_COLLECTION).doc("console").get();
    const presenceData = presenceDoc.data() || {};
    const updatedAtMillis =
      typeof presenceData.updatedAt?.toMillis === "function" ? presenceData.updatedAt.toMillis() : 0;
    const online = updatedAtMillis > 0 && Date.now() - updatedAtMillis < 45_000;

    const activeCallsSnapshot = await firestore
      .collection(CALLS_COLLECTION)
      .where("status", "in", ACTIVE_CALL_STATUSES)
      .get();
    const activeCalls = activeCallsSnapshot.size;
    const estimatedWaitMinutes = Math.max(0, (activeCalls - 1) * 6);

    return res.json({
      online,
      activeCalls,
      estimatedWaitMinutes
    });
  } catch (err) {
    if (isFirestoreQuotaExceeded(err)) {
      return res.json({
        online: false,
        activeCalls: 0,
        estimatedWaitMinutes: 0,
        degraded: true
      });
    }
    return res.status(500).json({ error: err?.message || "Failed to fetch presence." });
  }
});

async function ensureDb() {
  const pool = getPool();
  if (!pool) return;
  if (!dbInitPromise) {
    dbInitPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS ai_requests (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        provider TEXT,
        endpoint TEXT,
        user_question TEXT,
        entry_count INT,
        payload JSONB,
        response JSONB,
        success BOOLEAN,
        error TEXT
      );
    `);
  }
  await dbInitPromise;
}

async function logAIRequest({ provider, endpoint, payload, response, success, error }) {
  try {
    const pool = getPool();
    if (!pool) return;
    await ensureDb();
    const entryCount = Array.isArray(payload?.entries) ? payload.entries.length : 0;
    const userQuestion = payload?.userQuestion ?? null;
    await pool.query(
      `INSERT INTO ai_requests (provider, endpoint, user_question, entry_count, payload, response, success, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
      [
        provider,
        endpoint,
        userQuestion,
        entryCount,
        payload || null,
        response || null,
        success ?? null,
        error ?? null
      ]
    );
  } catch (err) {
    console.warn("Failed to log AI request:", err?.message || err);
  }
}

function buildUserPayload(request) {
  const { entries, timeframe, userPrefs, locale, timezone, userQuestion, preferredLanguage, medicalContext } = request || {};

  const sanitizedEntries = Array.isArray(entries)
    ? entries.map((entry) => ({
        id: entry.id,
        symptomType: entry.symptomType,
        severity: entry.severity,
        onset: entry.onset ?? null,
        durationMinutes: entry.durationMinutes ?? null,
        triggers: entry.triggers ?? [],
        notes: entry.notes ?? null,
        medsTaken: Array.isArray(entry.medsTaken) ? entry.medsTaken : [],
        sleepHours: userPrefs?.dataMinimizationOn ? null : entry.sleepHours ?? null,
        hydrationLiters: userPrefs?.dataMinimizationOn ? null : entry.hydrationLiters ?? null,
        caffeineMg: userPrefs?.dataMinimizationOn ? null : entry.caffeineMg ?? null,
        alcoholUnits: userPrefs?.dataMinimizationOn ? null : entry.alcoholUnits ?? null
      }))
    : [];

  return {
    userQuestion: userQuestion || "Analyze my logs",
    timeframe,
    locale,
    timezone,
    preferredLanguage: preferredLanguage || "English",
    userPrefs,
    medicalContext: medicalContext || null,
    entries: sanitizedEntries
  };
}

async function callOpenAI(input) {
  if (!OPENAI_API_KEY) {
    return { error: "Missing OPENAI_API_KEY" };
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input,
      text: {
        format: {
          type: "json_schema",
          name: "SymptomNerdAIResponse",
          schema: responseSchema,
          strict: true
        }
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || "OpenAI error";
    throw new Error(message);
  }

  const outputText = data.output_text || data.output?.[0]?.content?.[0]?.text;
  if (!outputText) {
    throw new Error("No output_text returned from OpenAI");
  }

  return JSON.parse(outputText);
}

async function callGemini(contents, payload, useSchema = true) {
  if (!GEMINI_API_KEY) {
    return fallbackResponse("Missing GEMINI_API_KEY", payload);
  }

  const body = useSchema
    ? {
        system_instruction: {
          parts: [{ text: systemPrompt }]
        },
        contents,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: geminiResponseSchema
        }
      }
    : {
        system_instruction: {
          parts: [{ text: systemPrompt }]
        },
        contents
      };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );

    const data = await response.json();
    if (!response.ok) {
      const message =
        data?.error?.message ||
        data?.error?.status ||
        "Gemini error";
      if (useSchema && /responseMimeType|responseSchema/i.test(message)) {
        return callGemini(contents, payload, false);
      }
      return fallbackResponse(message, payload);
    }

    const outputText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!outputText) {
      return fallbackResponse("No output text returned from Gemini", payload);
    }

    return normalizeAIResponse(parseJsonResponse(outputText, payload), payload);
  } catch (error) {
    const message = error?.name === "AbortError" ? "Gemini request timed out" : error?.message || "Gemini error";
    return fallbackResponse(message, payload);
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonResponse(text, payload) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      const slice = text.slice(start, end + 1);
      return JSON.parse(slice);
    }
    return fallbackResponse(text, payload);
  }
}

function fallbackResponse(text, payload) {
  const fallbackFromPayload = buildFallbackFromPayload(payload);
  if (fallbackFromPayload) {
    if (text && !/Summary unavailable/i.test(text)) {
      fallbackFromPayload.disclaimer =
        fallbackFromPayload.disclaimer + " (AI service note: " + text + ")";
    }
    return fallbackFromPayload;
  }
  return {
    recap: text.slice(0, 400) || "Summary unavailable.",
    patterns: [],
    suggestions: [
      "Consider tracking when symptoms start and any possible triggers.",
      "If anything feels urgent or severe, seek medical care."
    ],
    redFlags: [],
    questionsForClinician: ["What additional details would be helpful to record?"],
    disclaimer:
      "This app provides informational pattern-based insights only and does not provide medical diagnosis. If you think this may be an emergency, call your local emergency number."
  };
}

function normalizeAIResponse(raw, payload) {
  if (
    raw &&
    typeof raw === "object" &&
    typeof raw.recap === "string" &&
    Array.isArray(raw.patterns) &&
    Array.isArray(raw.suggestions) &&
    Array.isArray(raw.redFlags) &&
    Array.isArray(raw.questionsForClinician) &&
    typeof raw.disclaimer === "string"
  ) {
    const cleaned = {
      recap: raw.recap,
      patterns: sanitizeList(raw.patterns),
      suggestions: sanitizeList(raw.suggestions),
      redFlags: Array.isArray(raw.redFlags) ? raw.redFlags : [],
      questionsForClinician: sanitizeList(raw.questionsForClinician),
      disclaimer: raw.disclaimer
    };
    return ensureRelevant(cleaned, payload);
  }

  const summary = raw?.summary || {};
  const recapParts = [];
  if (Array.isArray(summary.notedSymptoms)) recapParts.push(...summary.notedSymptoms);
  if (Array.isArray(summary.generalObservations)) recapParts.push(...summary.generalObservations.slice(0, 1));
  const recap = recapParts.join(" ").trim() || "Summary unavailable.";

  const patterns = sanitizeList([
    ...(Array.isArray(summary.identifiedPatterns) ? summary.identifiedPatterns : []),
    ...(Array.isArray(summary.potentialCorrelations) ? summary.potentialCorrelations : [])
  ]);

  const suggestions = sanitizeList([
    ...(Array.isArray(summary.generalObservations) ? summary.generalObservations : []),
    ...(Array.isArray(raw?.warnings) ? raw.warnings : [])
  ]);
  if (suggestions.length === 0) {
    suggestions.push(
      "Consider tracking when symptoms start and any possible triggers.",
      "If anything feels urgent or severe, seek medical care."
    );
  }

  const disclaimer = [raw?.disclaimer, raw?.emergencyGuidance]
    .filter(Boolean)
    .join(" ")
    .trim() ||
    "This app provides informational pattern-based insights only and does not provide medical diagnosis. If you think this may be an emergency, call your local emergency number.";

  return ensureRelevant({
    recap,
    patterns,
    suggestions,
    redFlags: [],
    questionsForClinician: sanitizeList([
      "What additional details should I track?",
      "Are there any warning signs I should watch for?"
    ]),
    disclaimer
  }, payload);
}

function ensureRelevant(response, payload) {
  const fallback = buildFallbackFromPayload(payload);
  if (!fallback) return response;

  const symptomNames = Array.from(
    new Set((payload?.entries || []).map((entry) => entry.symptomType).filter(Boolean))
  );
  const question = payload?.userQuestion ? String(payload.userQuestion).trim() : "";
  const recap = response?.recap || "";
  const recapLower = recap.toLowerCase();
  const mentionsSymptom =
    symptomNames.length === 0 ||
    symptomNames.some((name) => recapLower.includes(String(name).toLowerCase()));
  const mentionsQuestion = question.length === 0 ? true : containsQuestionKeyword(recapLower, question);
  const isSummaryUnavailable = /summary unavailable|summary not available|unable to summarize/i.test(recapLower);

  if (!mentionsSymptom || !mentionsQuestion || recap.trim().length < 8 || isSummaryUnavailable) {
    response.recap = fallback.recap;
  }
  if (!Array.isArray(response.suggestions) || response.suggestions.length === 0) {
    response.suggestions = fallback.suggestions;
  }
  if (!Array.isArray(response.questionsForClinician) || response.questionsForClinician.length === 0) {
    response.questionsForClinician = fallback.questionsForClinician;
  }
  if (!response.disclaimer || response.disclaimer.length < 20) {
    response.disclaimer = fallback.disclaimer;
  }
  if (response.disclaimer && !/emergency number/i.test(response.disclaimer)) {
    response.disclaimer = response.disclaimer.trim() + " If you think this may be an emergency, call your local emergency number.";
  }
  if (!Array.isArray(response.redFlags)) {
    response.redFlags = [];
  }
  if (!Array.isArray(response.patterns) || response.patterns.length === 0) {
    response.patterns = fallback.patterns ?? [];
  } else {
    response.patterns = sanitizeList(response.patterns);
  }
  response.questionsForClinician = sanitizeList(response.questionsForClinician);
  response.suggestions = sanitizeList(response.suggestions);
  return response;
}

function containsQuestionKeyword(recapLower, question) {
  const cleaned = question.toLowerCase().replace(/[^a-z0-9\\s]/g, " ");
  const keywords = cleaned.split(/\\s+/).filter((word) => word.length >= 4);
  if (keywords.length === 0) {
    return recapLower.includes(cleaned.trim());
  }
  return keywords.some((word) => recapLower.includes(word));
}

function sanitizeList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0)
    .slice(0, 8);
}

function buildFallbackFromPayload(payload) {
  if (!payload || !Array.isArray(payload.entries)) return null;
  const entries = payload.entries;
  const timeframe = payload.timeframe;
  const medicalContext = payload.medicalContext || null;
  const uniqueSymptoms = Array.from(
    new Set(entries.map((entry) => entry.symptomType).filter(Boolean))
  );
  const triggers = Array.from(
    new Set(entries.flatMap((entry) => entry.triggers || []).filter(Boolean))
  );
  const recapParts = [];
  if (payload?.userQuestion) {
    const cleaned = String(payload.userQuestion).split("\n")[0].slice(0, 140);
    recapParts.push(`You asked: ${cleaned}.`);
  }
  if (uniqueSymptoms.length > 0) {
    recapParts.push(`You logged: ${uniqueSymptoms.join(", ")}.`);
  }
  if (entries.length > 0) {
    const severities = entries.map((entry) => entry.severity).filter((value) => typeof value === "number");
    if (severities.length > 0) {
      const avg = severities.reduce((sum, value) => sum + value, 0) / severities.length;
      recapParts.push(`Average severity: ${avg.toFixed(1)}/10.`);
    }
  }
  if (timeframe?.start && timeframe?.end) {
    recapParts.push(`Timeframe: ${timeframe.start} to ${timeframe.end}.`);
  }
  if (medicalContext) {
    const contextualSignals = [
      medicalContext.chronicConditions,
      medicalContext.currentMedications,
      medicalContext.allergies
    ]
      .filter(Boolean)
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0);
    if (contextualSignals.length > 0) {
      recapParts.push("I also considered your medical profile context while interpreting these logs.");
    }
  }
  if (recapParts.length === 0) {
    recapParts.push(`You asked: ${payload.userQuestion || "Analyze my logs."}`);
  }

  const patterns = [];
  if (uniqueSymptoms.length > 0) {
    patterns.push(`Symptoms logged: ${uniqueSymptoms.join(", ")}.`);
  }
  if (triggers.length > 0) {
    patterns.push(`Possible triggers noted: ${triggers.join(", ")}.`);
  }
  if (medicalContext?.recentHealthHistory?.length) {
    patterns.push(`Recent health history entries were considered (${medicalContext.recentHealthHistory.length} records).`);
  }

  const suggestions = [
    "Continue logging when symptoms start, how long they last, and any possible triggers.",
    "If symptoms feel severe or rapidly worsening, consider urgent medical care."
  ];
  if (medicalContext?.currentMedications) {
    suggestions.push("Because medications are listed in your profile, ask a pharmacist to review for possible interaction or side-effect overlap.");
  }

  return {
    recap: recapParts.join(" "),
    patterns,
    suggestions,
    redFlags: [],
    questionsForClinician: [
      "What additional details should I track about these symptoms?",
      "Are there warning signs specific to this symptom I should watch for?"
    ],
    disclaimer:
      "This app provides informational pattern-based insights only and does not provide medical diagnosis. If you think this may be an emergency, call your local emergency number."
  };
}

app.post("/ai/analyze", async (req, res) => {
  let payload;
  try {
    payload = buildUserPayload(req.body.request);
    let result;
    if (AI_PROVIDER === "gemini") {
      const contents = [
        {
          role: "user",
          parts: [
            {
              text:
                "User question: " +
                (payload.userQuestion || "Analyze my logs") +
                "\n\nPayload:\n" +
                JSON.stringify(payload)
            }
          ]
        }
      ];
      result = await callGemini(contents, payload);
    } else {
      const input = [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(payload) }
      ];
      result = normalizeAIResponse(await callOpenAI(input), payload);
    }
    logAIRequest({ provider: AI_PROVIDER, endpoint: "/ai/analyze", payload, response: result, success: true });
    res.json(result);
  } catch (error) {
    logAIRequest({
      provider: AI_PROVIDER,
      endpoint: "/ai/analyze",
      payload,
      response: null,
      success: false,
      error: error.message || "Server error"
    });
    res.status(500).json({ error: error.message || "Server error" });
  }
});

app.post("/ai/chat", async (req, res) => {
  let payload;
  try {
    payload = buildUserPayload(req.body.request);
    const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    const trimmedMessages = messages.slice(-6);
    let result;
    if (AI_PROVIDER === "gemini") {
      const contents = [
        ...trimmedMessages.map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: message.content }]
        })),
        {
          role: "user",
          parts: [
            {
              text:
                "User question: " +
                (payload.userQuestion || "Analyze my logs") +
                "\n\nPayload:\n" +
                JSON.stringify(payload)
            }
          ]
        }
      ];
      result = await callGemini(contents, payload);
    } else {
      const input = [
        { role: "system", content: systemPrompt },
        ...trimmedMessages.map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: message.content
        })),
        { role: "user", content: JSON.stringify(payload) }
      ];
      result = normalizeAIResponse(await callOpenAI(input), payload);
    }
    logAIRequest({ provider: AI_PROVIDER, endpoint: "/ai/chat", payload, response: result, success: true });
    res.json(result);
  } catch (error) {
    logAIRequest({
      provider: AI_PROVIDER,
      endpoint: "/ai/chat",
      payload,
      response: null,
      success: false,
      error: error.message || "Server error"
    });
    res.status(500).json({ error: error.message || "Server error" });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const HOST = process.env.HOST || "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`Symptom Nerd backend listening on http://${HOST}:${PORT}`);
  console.log(`AI provider: ${AI_PROVIDER}`);
});
