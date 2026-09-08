import { decodeBytes, encodeBytes, keys, libName, noOp, resetTimer, values } from "./utils.mjs";
import { createMediaIdentityCache } from "./media.mjs";
//#region src/shared-peer.ts
const roomFrameVersion = 1;
const roomPresenceFrameVersion = 2;
const wrapRoomFrame = (roomToken, data) => {
	const tokenBytes = encodeBytes(roomToken);
	const frame = new Uint8Array(3 + tokenBytes.byteLength + data.byteLength);
	frame[0] = roomFrameVersion;
	frame[1] = tokenBytes.byteLength >>> 8 & 255;
	frame[2] = tokenBytes.byteLength & 255;
	frame.set(tokenBytes, 3);
	frame.set(data, 3 + tokenBytes.byteLength);
	return frame;
};
const wrapRoomPresenceFrame = (roomToken, isPresent) => {
	const tokenBytes = encodeBytes(roomToken);
	const frame = new Uint8Array(4 + tokenBytes.byteLength);
	frame[0] = roomPresenceFrameVersion;
	frame[1] = Number(isPresent);
	frame[2] = tokenBytes.byteLength >>> 8 & 255;
	frame[3] = tokenBytes.byteLength & 255;
	frame.set(tokenBytes, 4);
	return frame;
};
const unwrapFrame = (data) => {
	const buffer = new Uint8Array(data);
	if (buffer.byteLength < 3) return null;
	if (buffer[0] === roomFrameVersion) {
		const tokenSize = (buffer[1] ?? 0) << 8 | (buffer[2] ?? 0);
		const headerSize = 3 + tokenSize;
		if (tokenSize <= 0 || buffer.byteLength < headerSize) return null;
		return {
			type: "room",
			roomToken: decodeBytes(buffer.subarray(3, headerSize)),
			payload: buffer.subarray(headerSize).slice().buffer
		};
	}
	if (buffer[0] !== roomPresenceFrameVersion || buffer.byteLength < 4) return null;
	const tokenSize = (buffer[2] ?? 0) << 8 | (buffer[3] ?? 0);
	const headerSize = 4 + tokenSize;
	if (tokenSize <= 0 || buffer.byteLength < headerSize) return null;
	return {
		type: "presence",
		roomToken: decodeBytes(buffer.subarray(4, headerSize)),
		isPresent: buffer[1] === 1
	};
};
const isPeerUnderlyingStale = (peer) => {
	const { connection, channel } = peer;
	return peer.isDead || connection.connectionState === "closed" || connection.connectionState === "failed" || connection.iceConnectionState === "closed" || connection.iceConnectionState === "failed" || channel?.readyState === "closing" || channel?.readyState === "closed";
};
const getConnectedPeerHealth = (peer) => {
	if (isPeerUnderlyingStale(peer)) return "stale";
	const { channel } = peer;
	if (!channel || channel.readyState !== "open") return "transient";
	return "live";
};
var SharedPeerManager = class {
	byApp = {};
	roomPresenceHandlers = {};
	getMap(appId) {
		return this.byApp[appId] ??= {};
	}
	get(appId, peerId) {
		return this.byApp[appId]?.[peerId];
	}
	isPeerStale(peer) {
		return isPeerUnderlyingStale(peer);
	}
	getHealth(peer) {
		return this.isPeerStale(peer) ? "stale" : "live";
	}
	setRoomPresenceHandler(appId, handler) {
		this.roomPresenceHandlers[appId] = handler;
		return () => {
			if (this.roomPresenceHandlers[appId] === handler) delete this.roomPresenceHandlers[appId];
		};
	}
	sendRoomPresence(shared, roomToken, isPresent) {
		if (shared.isClosing || shared.peer.isDead) return;
		shared.peer.sendData(wrapRoomPresenceFrame(roomToken, isPresent));
	}
	clear(appId, peerId, { destroyPeer }) {
		const map = this.byApp[appId];
		const shared = map?.[peerId];
		if (!shared || shared.isClosing) return;
		shared.idleTimer = resetTimer(shared.idleTimer);
		shared.isClosing = true;
		if (destroyPeer && !shared.peer.isDead) shared.peer.destroy();
		const bindings = values(shared.bindings);
		shared.bindings = {};
		shared.bindingsByToken = {};
		shared.controlRoomId = null;
		delete map[peerId];
		bindings.forEach((binding) => {
			binding.handlers.close?.();
			binding.pendingData.length = 0;
			binding.pendingSendData.length = 0;
			binding.pendingTracks.length = 0;
		});
		shared.media.clearRemote();
		shared.pendingDataByToken.clear();
		shared.remoteRoomTokens.clear();
		if (keys(map).length === 0) delete this.byApp[appId];
	}
	register(appId, peerId, peer, idleMs) {
		const map = this.getMap(appId);
		const existing = map[peerId];
		if (existing) {
			existing.idleTimer = resetTimer(existing.idleTimer);
			if (existing.peer === peer) return existing;
			this.clear(appId, peerId, { destroyPeer: true });
		}
		const shared = {
			appId,
			peerId,
			peer,
			bindings: {},
			bindingsByToken: {},
			pendingDataByToken: /* @__PURE__ */ new Map(),
			remoteRoomTokens: /* @__PURE__ */ new Set(),
			idleTimer: null,
			controlRoomId: null,
			streamOwners: /* @__PURE__ */ new Map(),
			trackOwners: /* @__PURE__ */ new Map(),
			media: createMediaIdentityCache(),
			idleMs,
			isClosing: false
		};
		peer.setHandlers({
			data: (data) => this.dispatchData(shared, data),
			signal: (signal) => this.dispatchSignal(shared, signal),
			close: () => this.clear(appId, peerId, { destroyPeer: false }),
			error: (err) => {
				console.error(`${libName} peer error:`, err);
				this.clear(appId, peerId, { destroyPeer: false });
			},
			track: (track, stream) => this.dispatchTrack(shared, track, stream)
		});
		map[peerId] = shared;
		return shared;
	}
	bind(roomId, roomTokenPromise, shared, { onDetach }) {
		const existingBinding = shared.bindings[roomId];
		if (existingBinding) {
			shared.idleTimer = resetTimer(shared.idleTimer);
			return {
				proxy: existingBinding.proxy,
				isNew: false
			};
		}
		const binding = {
			roomId,
			roomToken: null,
			roomTokenPromise,
			handlers: {},
			pendingData: [],
			pendingSendData: [],
			pendingTracks: [],
			detach: noOp,
			proxy: {}
		};
		const detachBinding = () => {
			if (!shared.bindings[roomId]) return;
			this.pruneRoomOwnership(shared, roomId);
			delete shared.bindings[roomId];
			if (binding.roomToken && shared.bindingsByToken[binding.roomToken] === binding) delete shared.bindingsByToken[binding.roomToken];
			if (shared.controlRoomId === roomId) shared.controlRoomId = keys(shared.bindings)[0] ?? null;
			onDetach();
			this.scheduleIdleTimer(shared);
		};
		const proxy = {
			created: shared.peer.created,
			get connection() {
				return shared.peer.connection;
			},
			get channel() {
				return shared.peer.channel;
			},
			get isDead() {
				return shared.peer.isDead;
			},
			getOffer: (restartIce) => shared.peer.getOffer(restartIce),
			signal: (sdp) => shared.peer.signal(sdp),
			sendData: (data) => {
				if (!binding.roomToken) {
					binding.pendingSendData.push(data);
					return;
				}
				shared.peer.sendData(wrapRoomFrame(binding.roomToken, data));
			},
			destroy: () => detachBinding(),
			setHandlers: (newHandlers) => {
				const { signal, ...rest } = newHandlers;
				Object.assign(binding.handlers, rest);
				if (signal) binding.handlers.signal = signal;
				this.flushBindingQueues(binding);
			},
			offerPromise: shared.peer.offerPromise,
			addStream: (stream) => {
				const owners = shared.streamOwners.get(stream) ?? /* @__PURE__ */ new Set();
				const shouldAttach = owners.size === 0;
				owners.add(roomId);
				shared.streamOwners.set(stream, owners);
				if (shouldAttach) shared.peer.addStream(stream);
			},
			removeStream: (stream) => {
				const owners = shared.streamOwners.get(stream);
				if (!owners) return;
				owners.delete(roomId);
				if (owners.size === 0) {
					shared.streamOwners.delete(stream);
					shared.peer.removeStream(stream);
				}
			},
			addTrack: (track, stream) => {
				const entry = shared.trackOwners.get(track) ?? {
					stream,
					rooms: /* @__PURE__ */ new Set()
				};
				const shouldAttach = entry.rooms.size === 0;
				entry.stream = stream;
				entry.rooms.add(roomId);
				shared.trackOwners.set(track, entry);
				if (shouldAttach) return shared.peer.addTrack(track, stream);
				return shared.peer.connection.getSenders().find((s) => s.track === track) ?? shared.peer.addTrack(track, stream);
			},
			removeTrack: (track) => {
				const entry = shared.trackOwners.get(track);
				if (!entry) return;
				entry.rooms.delete(roomId);
				if (entry.rooms.size === 0) {
					shared.trackOwners.delete(track);
					shared.peer.removeTrack(track);
				}
			},
			replaceTrack: (oldTrack, newTrack) => {
				const oldEntry = shared.trackOwners.get(oldTrack);
				if (oldEntry) {
					shared.trackOwners.delete(oldTrack);
					const nextEntry = shared.trackOwners.get(newTrack) ?? {
						stream: oldEntry.stream,
						rooms: /* @__PURE__ */ new Set()
					};
					oldEntry.rooms.forEach((room) => nextEntry.rooms.add(room));
					shared.trackOwners.set(newTrack, nextEntry);
				}
				return shared.peer.replaceTrack(oldTrack, newTrack);
			},
			__trysteroMedia: shared.media
		};
		binding.proxy = proxy;
		binding.detach = detachBinding;
		shared.bindings[roomId] = binding;
		shared.controlRoomId ??= roomId;
		shared.idleTimer = resetTimer(shared.idleTimer);
		roomTokenPromise.then((roomToken) => {
			if (shared.isClosing || shared.bindings[roomId] !== binding) return;
			binding.roomToken = roomToken;
			shared.bindingsByToken[roomToken] = binding;
			const pendingData = shared.pendingDataByToken.get(roomToken);
			if (pendingData?.length) {
				binding.pendingData.push(...pendingData);
				shared.pendingDataByToken.delete(roomToken);
			}
			binding.pendingSendData.splice(0).forEach((payload) => shared.peer.sendData(wrapRoomFrame(roomToken, payload)));
			this.flushBindingQueues(binding);
		});
		return {
			proxy,
			isNew: true
		};
	}
	pruneRoomOwnership(shared, roomIdToRemove) {
		shared.streamOwners.forEach((rooms, stream) => {
			rooms.delete(roomIdToRemove);
			if (rooms.size === 0) {
				shared.streamOwners.delete(stream);
				shared.peer.removeStream(stream);
			}
		});
		shared.trackOwners.forEach((entry, track) => {
			entry.rooms.delete(roomIdToRemove);
			if (entry.rooms.size === 0) {
				shared.trackOwners.delete(track);
				shared.peer.removeTrack(track);
			}
		});
	}
	scheduleIdleTimer(shared) {
		if (shared.isClosing || keys(shared.bindings).length > 0) return;
		shared.idleTimer = resetTimer(shared.idleTimer);
		shared.idleTimer = setTimeout(() => {
			const current = this.byApp[shared.appId]?.[shared.peerId];
			if (!current || keys(current.bindings).length > 0) return;
			this.clear(shared.appId, shared.peerId, { destroyPeer: true });
		}, shared.idleMs);
	}
	getSignalBinding(shared) {
		if (shared.controlRoomId) {
			const selected = shared.bindings[shared.controlRoomId];
			if (selected?.handlers.signal) return selected;
		}
		const fallback = values(shared.bindings).find((binding) => Boolean(binding.handlers.signal));
		if (!fallback) return null;
		shared.controlRoomId = fallback.roomId;
		return fallback;
	}
	flushBindingQueues(binding) {
		const { handlers } = binding;
		if (handlers.data && binding.pendingData.length > 0) binding.pendingData.splice(0).forEach((payload) => handlers.data?.(payload));
		if ((handlers.track || handlers.stream) && binding.pendingTracks.length) binding.pendingTracks.splice(0).forEach(({ track, stream }) => {
			handlers.track?.(track, stream);
			handlers.stream?.(stream);
		});
	}
	dispatchData(shared, data) {
		const decoded = unwrapFrame(data);
		if (!decoded) return;
		if (decoded.type === "presence") {
			if (decoded.isPresent) shared.remoteRoomTokens.add(decoded.roomToken);
			else shared.remoteRoomTokens.delete(decoded.roomToken);
			this.roomPresenceHandlers[shared.appId]?.(shared.peerId, decoded.roomToken, decoded.isPresent);
			return;
		}
		const binding = shared.bindingsByToken[decoded.roomToken];
		if (!binding) {
			const pending = shared.pendingDataByToken.get(decoded.roomToken) ?? [];
			pending.push(decoded.payload);
			shared.pendingDataByToken.set(decoded.roomToken, pending);
			return;
		}
		if (binding.handlers.data) binding.handlers.data(decoded.payload);
		else binding.pendingData.push(decoded.payload);
	}
	dispatchSignal(shared, signal) {
		this.getSignalBinding(shared)?.handlers.signal?.(signal);
	}
	dispatchTrack(shared, track, stream) {
		values(shared.bindings).forEach((binding) => {
			if (binding.handlers.track || binding.handlers.stream) {
				binding.handlers.track?.(track, stream);
				binding.handlers.stream?.(stream);
				return;
			}
			binding.pendingTracks.push({
				track,
				stream
			});
		});
	}
};
//#endregion
export { SharedPeerManager, getConnectedPeerHealth };

