/* ============================================================
   Cadence — multi-device sync (prototype)

   Peer-to-peer via Trystero (vendored, torrent-tracker signaling strategy
   — see vendor/trystero/VENDORED.md). No backend of our own: the only
   network dependencies are Trystero's default public WebTorrent trackers
   (signaling/rendezvous) and the default STUN servers baked into
   vendor/trystero/core/peer.mjs (Google + Cloudflare's public STUN, no
   TURN). That combination reliably finds a direct path between two
   devices on the same LAN — the expected case for this app — but has no
   relay fallback, so it can fail on a restrictive/symmetric-NAT network.

   Exactly one controller per room; every other peer is a view-only
   viewer. The controller is whoever's claim to the room goes
   unchallenged: on joining, a would-be controller broadcasts a "claim";
   any peer that already believes itself to be the controller answers
   with a "claimDenied" naming itself. If no denial arrives within
   CLAIM_WINDOW_MS, the claim stands. This also lets a viewer take over
   after the controller discononnects (room.onPeerLeave clears the known
   controller, re-enabling a fresh claim).
   ============================================================ */

import { joinRoom, selfId } from "./vendor/trystero/torrent.mjs";

const APP_ID = "cadence-standup-v1";
const CLAIM_WINDOW_MS = 900;
const ROOM_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O/1/I
const ROOM_CODE_LENGTH = 5;
const SESSION_KEY = "cadence.syncSession.v1";

let room = null;
let roomId = null;
let role = null; // "controller" | "viewer" | null
let controllerPeerId = null; // known controller's Trystero peer id, once settled
let latestState = null; // last {config, runtime} the controller broadcast
let actions = null; // { sendState, sendClaim, sendClaimDenied }
// Viewer-side estimate of (our clock) - (controller's clock), derived from
// a sentAt timestamp stamped onto each state message at the moment it's
// sent. Runtime timestamps like activeTurn.startedAt are all in the
// controller's clock, so a viewer subtracts this offset from its own
// Date.now() before deriving elapsed time, keeping counters in step even
// when the two devices' clocks disagree by a few seconds.
let clockOffsetMs = 0;

let onStateReceived = null;
let onControllerLost = null;
let onPeerCountChange = null;
let onBecameController = null;

// Persists {role, roomId} so a page refresh can silently rejoin the same
// room instead of dropping back to a disconnected state — the meeting
// content itself is restored separately (from the controller's own runtime
// storage, or from the next state broadcast for a viewer).
function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ role, roomId }));
  } catch (e) {}
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch (e) {}
}

function getStoredSession() {
  try {
    var raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    if (!parsed || !parsed.roomId || (parsed.role !== "controller" && parsed.role !== "viewer")) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function generateRoomCode() {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

function peerCount() {
  return room ? Object.keys(room.getPeers()).length : 0;
}

function wireActions() {
  const stateAction = room.makeAction("state");
  const claimAction = room.makeAction("claim");
  const claimDeniedAction = room.makeAction("claimDenied");

  stateAction.onMessage = (payload) => {
    if (role === "controller") return; // we are the source of truth, ignore echoes
    if (typeof payload.sentAt === "number") {
      clockOffsetMs = Date.now() - payload.sentAt;
    }
    latestState = payload;
    if (onStateReceived) onStateReceived(payload);
  };

  claimAction.onMessage = (_payload, meta) => {
    if (role === "controller") {
      claimDeniedAction.send({ controllerId: selfId }, meta.peerId);
    }
  };

  claimDeniedAction.onMessage = (payload) => {
    if (payload.controllerId !== selfId) {
      controllerPeerId = payload.controllerId;
    }
  };

  // onPeerJoin/onPeerLeave are property setters on the room object, not
  // methods to call — assigning (rather than invoking) is the real API.
  room.onPeerJoin = (peerId) => {
    if (role === "controller") {
      // A newcomer might also be trying to claim controller at this exact
      // moment (e.g. two devices both tapped "Host" for the same code) —
      // tell them immediately rather than waiting for their claim to land.
      claimDeniedAction.send({ controllerId: selfId }, peerId);
      if (latestState) stateAction.send(Object.assign({}, latestState, { sentAt: Date.now() }), peerId);
    }
    if (onPeerCountChange) onPeerCountChange(peerCount());
  };

  room.onPeerLeave = (peerId) => {
    if (peerId === controllerPeerId) {
      controllerPeerId = null;
      if (role === "viewer" && onControllerLost) onControllerLost();
    }
    if (onPeerCountChange) onPeerCountChange(peerCount());
  };

  return { stateAction, claimAction, claimDeniedAction };
}

// Broadcasts a claim to become controller and waits out CLAIM_WINDOW_MS for
// a denial. Resolves true if the claim stood (or no one else is in the
// room), false if another controller answered first.
function claimController() {
  return new Promise((resolve) => {
    controllerPeerId = null;
    actions.claimAction.send({});
    setTimeout(() => {
      resolve(controllerPeerId === null);
    }, CLAIM_WINDOW_MS);
  });
}

async function connect(code) {
  if (room) leave();
  roomId = code;
  room = joinRoom({
    appId: APP_ID,
    // Trystero's torrent strategy only connects to 3 of its 5 built-in
    // public WebTorrent trackers by default (relayConfig.redundancy). Any
    // one of those community-run trackers can be slow, rate-limiting, or
    // briefly down — with only 3 in play, that's enough to make signaling
    // (finding the other peer at all, before any WebRTC/NAT question even
    // applies) noticeably flaky. Using all 5 raises the odds both sides
    // share a working one.
    relayConfig: { redundancy: 5 },
    // Extra public STUN servers alongside Trystero's own defaults (Google
    // + Cloudflare). This is NOT expected to fix same-LAN flakiness — STUN
    // only helps NAT traversal, and two devices on one network usually
    // connect via local candidates without needing STUN at all — but it's
    // cheap insurance for the off-LAN case.
    turnConfig: [
      { urls: "stun:stun.stunprotocol.org:3478" },
      { urls: "stun:global.stun.twilio.com:3478" }
    ]
  }, code);
  actions = wireActions();
}

async function hostMeeting(code) {
  await connect(code);
  const won = await claimController();
  role = won ? "controller" : "viewer";
  if (won && onBecameController) onBecameController();
  saveSession();
  return role;
}

async function joinMeeting(code) {
  await connect(code);
  role = "viewer";
  saveSession();
  return role;
}

// Lets a viewer retry the claim — the normal path after the controller
// disconnects (onControllerLost fires), so the meeting can continue on
// whichever device picks it up first.
async function tryBecomeController() {
  if (!room || role === "controller") return role;
  const won = await claimController();
  if (won) {
    role = "controller";
    if (onBecameController) onBecameController();
  }
  return role;
}

function broadcastState(config, runtime) {
  if (!room || role !== "controller") return;
  latestState = { config, runtime };
  actions.stateAction.send(Object.assign({}, latestState, { sentAt: Date.now() }));
}

function leave() {
  if (room) room.leave();
  room = null;
  roomId = null;
  role = null;
  controllerPeerId = null;
  latestState = null;
  actions = null;
  clockOffsetMs = 0;
  clearSession();
}

window.CadenceSync = {
  generateRoomCode,
  hostMeeting,
  joinMeeting,
  tryBecomeController,
  broadcastState,
  leave,
  isConnected: () => !!room,
  getRole: () => role,
  getRoomId: () => roomId,
  getPeerCount: peerCount,
  getClockOffsetMs: () => clockOffsetMs,
  getStoredSession,
  get onStateReceived() { return onStateReceived; },
  set onStateReceived(cb) { onStateReceived = cb; },
  get onControllerLost() { return onControllerLost; },
  set onControllerLost(cb) { onControllerLost = cb; },
  get onPeerCountChange() { return onPeerCountChange; },
  set onPeerCountChange(cb) { onPeerCountChange = cb; },
  get onBecameController() { return onBecameController; },
  set onBecameController(cb) { onBecameController = cb; }
};
