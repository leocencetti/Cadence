import { entries, fromEntries, isBrowser, keys, libName, mkErr, noOp, toError } from "./utils.mjs";
import { createHandshakeManager } from "./handshake.mjs";
import { createActionManager } from "./actions.mjs";
import { createMediaManager } from "./media.mjs";
//#region src/room.ts
const unloadEvent = "beforeunload";
const defaultHandshakeTimeoutMs = 1e4;
const internalNs = (ns) => "@_" + ns;
const beforeUnloadRoomCleanups = /* @__PURE__ */ new Set();
const cleanupActiveRoomsOnBeforeUnload = () => beforeUnloadRoomCleanups.forEach((cleanup) => cleanup());
const registerBeforeUnloadCleanup = (cleanup) => {
	beforeUnloadRoomCleanups.add(cleanup);
	if (beforeUnloadRoomCleanups.size === 1) addEventListener(unloadEvent, cleanupActiveRoomsOnBeforeUnload);
	return () => {
		beforeUnloadRoomCleanups.delete(cleanup);
		if (!beforeUnloadRoomCleanups.size) removeEventListener(unloadEvent, cleanupActiveRoomsOnBeforeUnload);
	};
};
var room_default = (onPeer, onPeerLeave, onSelfLeave, { onPeerHandshake, onHandshakeError, handshakeTimeoutMs = defaultHandshakeTimeoutMs, isPassive = false } = {}) => {
	const peerMap = {};
	const activePeerMap = {};
	const pendingPongs = {};
	const listeners = {
		onPeerJoin: null,
		onPeerLeave: null
	};
	let unregisterBeforeUnloadCleanup = noOp;
	let handshakeManager = null;
	const iterate = (targets, f, { includePending = false } = {}) => (targets ? Array.isArray(targets) ? targets : [targets] : keys(includePending ? peerMap : activePeerMap)).flatMap((id) => {
		const peer = includePending ? peerMap[id] : activePeerMap[id];
		if (!peer) {
			console.warn(`${libName}: no peer with id ${id} found`);
			return [];
		}
		return [Promise.resolve(f(id, peer))];
	});
	const mediaManager = createMediaManager({
		iterate: (targets, f) => iterate(targets, (id, peer) => f(id, peer)),
		isActive: (id) => Boolean(activePeerMap[id]),
		getSharedMediaPeer: (id) => peerMap[id] ?? null
	});
	const actionManager = createActionManager({
		getPeer: (id, includePending) => (includePending ? peerMap : activePeerMap)[id],
		getPeerIds: (includePending) => keys(includePending ? peerMap : activePeerMap),
		canReceiveFromPeer: (id, receiveWhilePending) => Boolean(handshakeManager?.canReceiveFromPeer(id, receiveWhilePending))
	});
	const makeActionInternal = actionManager.makeInternalAction;
	const handleData = actionManager.handleData;
	const makeAction = actionManager.makeAction;
	const clearPeerState = (id, reason = mkErr("peer disconnected")) => {
		const err = toError(reason, "peer disconnected");
		handshakeManager?.clearPeer(id, err);
		delete peerMap[id];
		delete activePeerMap[id];
		actionManager.clearPeer(id, err);
		pendingPongs[id]?.splice(0).forEach((waiter) => waiter.reject(err));
		delete pendingPongs[id];
		mediaManager.clearPeer(id);
	};
	const exitPeer = (id, peer, reason) => {
		const current = peerMap[id];
		if (!current) return;
		if (peer && current !== peer) return;
		const wasActive = Boolean(activePeerMap[id]);
		clearPeerState(id, reason);
		current.destroy();
		if (wasActive) listeners.onPeerLeave?.(id);
		onPeerLeave(id);
	};
	const leave = async () => {
		await leaveAction.send("");
		await new Promise((res) => setTimeout(res, 99));
		entries(peerMap).forEach(([id, peer]) => {
			peer.destroy();
			clearPeerState(id, mkErr("room left"));
		});
		unregisterBeforeUnloadCleanup();
		onSelfLeave();
	};
	const pingAction = makeActionInternal(internalNs("ping"));
	const pongAction = makeActionInternal(internalNs("pong"));
	const signalAction = makeActionInternal(internalNs("signal"));
	const streamMetaAction = makeActionInternal(internalNs("stream"));
	const trackMetaAction = makeActionInternal(internalNs("track"));
	const leaveAction = makeActionInternal(internalNs("leave"), {
		sendToPending: true,
		receiveWhilePending: true
	});
	const handshakeDataAction = makeActionInternal(internalNs("hsdata"), {
		sendToPending: true,
		receiveWhilePending: true
	});
	const handshakeReadyAction = makeActionInternal(internalNs("hsready"), {
		sendToPending: true,
		receiveWhilePending: true
	});
	handshakeManager = createHandshakeManager({
		...onPeerHandshake === void 0 ? {} : { onPeerHandshake },
		...onHandshakeError === void 0 ? {} : { onHandshakeError },
		handshakeTimeoutMs,
		sendHandshakeData: handshakeDataAction.send,
		sendHandshakeReady: handshakeReadyAction.send,
		onActivate: (id, peer) => {
			activePeerMap[id] = peer;
			listeners.onPeerJoin?.(id);
		},
		onFailure: (id, peer, reason) => exitPeer(id, peer, reason)
	});
	pingAction.onMessage((_, id) => pongAction.send("", id));
	pongAction.onMessage((_, id) => {
		const queue = pendingPongs[id];
		(queue?.shift())?.resolve();
		if (queue && !queue.length) delete pendingPongs[id];
	});
	signalAction.onMessage((sdp, id) => {
		if (!activePeerMap[id]) return;
		peerMap[id]?.signal(sdp);
	});
	streamMetaAction.onMessage((meta, id) => mediaManager.receiveStreamMeta(meta, id));
	trackMetaAction.onMessage((meta, id) => mediaManager.receiveTrackMeta(meta, id));
	leaveAction.onMessage((_, id) => exitPeer(id, void 0, mkErr("peer left room")));
	handshakeDataAction.onMessage((data, id, metadata) => handshakeManager?.receiveHandshakeData(data, id, metadata));
	handshakeReadyAction.onMessage((_, id) => handshakeManager?.receiveHandshakeReady(id));
	onPeer((peer, id) => {
		const existingPeer = peerMap[id];
		if (existingPeer) {
			if (existingPeer === peer) return;
			existingPeer.destroy();
			clearPeerState(id, mkErr("peer replaced"));
		}
		peerMap[id] = peer;
		handshakeManager?.addPeer(id, peer);
		peer.setHandlers({
			data: (d) => handleData(id, d),
			stream: (stream) => mediaManager.receiveRemoteStream(id, stream),
			track: (track, stream) => mediaManager.receiveRemoteTrack(id, track, stream),
			signal: (sdp) => {
				if (!activePeerMap[id]) return;
				signalAction.send(sdp, id);
			},
			close: () => exitPeer(id, peer, mkErr("peer disconnected")),
			error: (err) => {
				console.error(`${libName} peer error:`, err);
				exitPeer(id, peer, err);
			}
		});
		handshakeManager?.start(id, peer);
	});
	if (isBrowser) unregisterBeforeUnloadCleanup = registerBeforeUnloadCleanup(() => leave().catch(noOp));
	return {
		makeAction,
		leave,
		ping: async (id) => {
			if (!activePeerMap[id]) throw mkErr(`no active peer with id ${id}`);
			const start = Date.now();
			await new Promise((resolve, reject) => {
				const queue = pendingPongs[id] ??= [];
				const clearFromQueue = () => {
					const currentQueue = pendingPongs[id];
					if (!currentQueue) return;
					const i = currentQueue.indexOf(waiter);
					if (i > -1) currentQueue.splice(i, 1);
					if (!currentQueue.length) delete pendingPongs[id];
				};
				const waiter = {
					resolve: () => {
						clearFromQueue();
						resolve();
					},
					reject: (reason) => {
						clearFromQueue();
						reject(reason);
					}
				};
				queue.push(waiter);
				pingAction.send("", id).catch((err) => waiter.reject(toError(err, "peer disconnected")));
			});
			return Date.now() - start;
		},
		isPassive: () => isPassive,
		getPeers: () => fromEntries(entries(activePeerMap).map(([id, peer]) => [id, peer.connection])),
		addStream: (stream, options = {}) => mediaManager.addStream(stream, options, streamMetaAction.send),
		removeStream: (stream, options = {}) => {
			mediaManager.removeStream(stream, options.target);
		},
		addTrack: (track, stream, options = {}) => mediaManager.addTrack(track, stream, options, trackMetaAction.send),
		removeTrack: (track, options = {}) => {
			mediaManager.removeTrack(track, options.target);
		},
		replaceTrack: (oldTrack, newTrack, options = {}) => mediaManager.replaceTrack(oldTrack, newTrack, options, trackMetaAction.send),
		get onPeerJoin() {
			return listeners.onPeerJoin;
		},
		set onPeerJoin(handler) {
			listeners.onPeerJoin = handler;
			if (handler) keys(activePeerMap).forEach((peerId) => handler(peerId));
		},
		get onPeerLeave() {
			return listeners.onPeerLeave;
		},
		set onPeerLeave(handler) {
			listeners.onPeerLeave = handler;
		},
		get onPeerStream() {
			return mediaManager.onPeerStream;
		},
		set onPeerStream(handler) {
			mediaManager.onPeerStream = handler;
		},
		get onPeerTrack() {
			return mediaManager.onPeerTrack;
		},
		set onPeerTrack(handler) {
			mediaManager.onPeerTrack = handler;
		}
	};
};
//#endregion
export { room_default as default };

