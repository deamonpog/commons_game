const $ = (id) => document.getElementById(id);

const nameEl = $("name");
const roomEl = $("room");
const hostEl = $("host");
const connectBtn = $("connect");
const statusEl = $("status");
const toastEl = $("toast");

const gStatus = $("gStatus");
const gRound = $("gRound");
const gResource = $("gResource");
const players = $("players");
const submitted = $("submitted");
const regen = $("regen");

const selectedEl = $("selected");
const submitBtn = $("submit");
const clearBtn = $("clear");

const hostPanel = $("hostPanel");
const startBtn = $("start");
const advanceBtn = $("advance");
const resetBtn = $("reset");

const sRound = $("sRound");
const sTotal = $("sTotal");
const sBefore = $("sBefore");
const sRegen = $("sRegen");
const sNew = $("sNew");
const sBreakdown = $("sBreakdown");

const choiceBtns = Array.from(document.querySelectorAll("button.choice"));

let ws = null;
let selectedChoice = null;
let isHost = false;
let lastState = null;

// IMPORTANT: set this after you deploy PartyKit
// Example: https://commons-game.<your-username>.partykit.dev
const PARTYKIT_BASE = "PASTE_YOUR_PARTYKIT_BASE_URL_HERE";

function sanitizeRoom(s) {
  return (s || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function showToast(msg) {
  toastEl.textContent = msg;
  setTimeout(() => {
    if (toastEl.textContent === msg) toastEl.textContent = "";
  }, 2500);
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function updateUI(state) {
  lastState = state;

  gStatus.textContent = state.status;
  gRound.textContent = state.round;
  gResource.textContent = state.resource;

  players.textContent = state.playersCount;
  submitted.textContent = state.submittedCount;
  regen.textContent = state.regenNext;

  hostPanel.classList.toggle("hidden", !isHost);

  // Summary
  const s = state.lastSummary || {};
  sRound.textContent = s.round ?? "—";
  sTotal.textContent = s.totalExtracted ?? "—";
  sBefore.textContent = s.beforeRegen ?? "—";
  sRegen.textContent = s.regenAdded ?? "—";
  sNew.textContent = s.newResource ?? "—";
  sBreakdown.textContent = s.breakdown ? JSON.stringify(s.breakdown, null, 2) : "—";

  // enable submit only if active round and not ended
  const canAct = state.status === "active" && state.round > 0;
  submitBtn.disabled = !(canAct && selectedChoice != null);
  clearBtn.disabled = !(canAct && selectedChoice != null);

  // if game ended, lock choices
  if (!canAct) {
    submitBtn.disabled = true;
    clearBtn.disabled = true;
  }
}

connectBtn.addEventListener("click", () => {
  const name = (nameEl.value || "").trim().slice(0, 24);
  const room = sanitizeRoom(roomEl.value);

  if (!PARTYKIT_BASE || PARTYKIT_BASE.includes("PASTE_")) {
    setStatus("Set PARTYKIT_BASE in web/app.js after deploying the server.");
    return;
  }
  if (!name) {
    setStatus("Enter a name.");
    return;
  }
  if (!room) {
    setStatus("Enter a Room ID.");
    return;
  }

  isHost = !!hostEl.checked;

  const url = `${PARTYKIT_BASE.replace(/\/$/, "")}/party/${room}`;
  ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    setStatus(`Connected to room: ${room} ${isHost ? "(HOST)" : ""}`);
    send({ type: "join", name, isHost });
  });

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "state") updateUI(msg.state);
    if (msg.type === "toast") showToast(msg.message);
  });

  ws.addEventListener("close", () => setStatus("Disconnected"));
  ws.addEventListener("error", () => setStatus("Connection error"));
});

choiceBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedChoice = Number(btn.dataset.c);
    selectedEl.textContent = selectedChoice;
    if (lastState) updateUI(lastState);
  });
});

clearBtn.addEventListener("click", () => {
  selectedChoice = null;
  selectedEl.textContent = "—";
  if (lastState) updateUI(lastState);
});

submitBtn.addEventListener("click", () => {
  if (!selectedChoice) return;
  send({ type: "choose", choice: selectedChoice });
  showToast(`Submitted ${selectedChoice}`);
  // keep selected; host advances when ready
});

startBtn.addEventListener("click", () => send({ type: "host_start" }));
advanceBtn.addEventListener("click", () => send({ type: "host_advance" }));
resetBtn.addEventListener("click", () => send({ type: "host_reset" }));
