import { all, entries, keys, libName, mkErr, noOp, resetTimer, selfId, toErrorMessage, topicPath, values, watchOnline } from "./utils.mjs";
import { decrypt, deriveRoomNamespace, encrypt, genKey, sha1 } from "./crypto.mjs";
import { OfferPool, offerTtl } from "./offer-pool.mjs";
import { createPasswordHandshake } from "./handshake.mjs";
import peer_default from "./peer.mjs";
import room_default from "./room.mjs";
import { SharedPeerManager } from "./shared-peer.mjs";
import { clearConnectedPeer, createSignalHandler, getState, resetOfferState, updateStatus } from "./signal-handler.mjs";
//#region src/strategy.ts
const announceIntervalMs = 5333;
const announceWarmupIntervalsMs = [
	233,
	533,
	1333
];
const passiveActivationGraceMs = 7533;
const sharedPeerIdleMsDefault = 123333;
var strategy_default = ({ init, subscribe, announce, deactivate }) => {
	const occupiedRooms = {};
	const roomRegistrations = {};
	const roomIdsByToken = {};
	const roomPresenceHandlerCleanups = {};
	const sharedPeers = new SharedPeerManager();
	const hasActiveRooms = () => values(occupiedRooms).some((rooms) => keys(rooms).length > 0);
	const getRoomRegistrations = (appId) => roomRegistrations[appId] ??= {};
	const getRoomIdsByToken = (appId) => roomIdsByToken[appId] ??= {};
	const advertiseRoomPresence = (shared, roomToken, isPresent) => {
		if (sharedPeers.getHealth(shared.peer) === "live") sharedPeers.sendRoomPresence(shared, roomToken, isPresent);
	};
	const advertiseKnownRoomsToShared = (appId, shared) => {
		entries(roomRegistrations[appId] ?? {}).forEach(([roomId, registration]) => {
			if (!registration.shouldAdvertise()) return;
			const { roomToken, roomTokenPromise } = registration;
			if (roomToken) {
				advertiseRoomPresence(shared, roomToken, true);
				return;
			}
			roomTokenPromise.then((token) => {
				if (roomRegistrations[appId]?.[roomId] !== registration) return;
				if (registration.roomToken !== token) return;
				if (sharedPeers.get(appId, shared.peerId) !== shared || shared.isClosing) return;
				if (!registration.shouldAdvertise()) return;
				advertiseRoomPresence(shared, token, true);
			});
		});
	};
	const advertiseRoomPresenceToAll = (appId, roomToken, isPresent) => values(sharedPeers.getMap(appId)).forEach((shared) => advertiseRoomPresence(shared, roomToken, isPresent));
	const ensureRoomPresenceHandler = (appId) => {
		if (roomPresenceHandlerCleanups[appId]) return;
		roomPresenceHandlerCleanups[appId] = sharedPeers.setRoomPresenceHandler(appId, (peerId, roomToken, isPresent) => {
			if (!isPresent) return;
			const shared = sharedPeers.get(appId, peerId);
			const roomId = roomIdsByToken[appId]?.[roomToken];
			if (!shared || !roomId) return;
			roomRegistrations[appId]?.[roomId]?.attachSharedPeerToRoom(peerId, shared);
		});
	};
	const cleanupRoomPresenceHandler = (appId) => {
		if (occupiedRooms[appId] && keys(occupiedRooms[appId]).length > 0) return;
		roomPresenceHandlerCleanups[appId]?.();
		delete roomPresenceHandlerCleanups[appId];
		delete roomRegistrations[appId];
		delete roomIdsByToken[appId];
	};
	let didInit = false;
	let initPromises = [];
	let offerPool = null;
	let cleanupWatchOnline = noOp;
	return (config, roomId, callbacks) => {
		if (!config) throw mkErr("requires a config map as the first argument");
		if (callbacks && typeof callbacks !== "object") throw mkErr("third argument must be a callbacks object");
		const { appId } = config;
		const onJoinError = callbacks?.onJoinError;
		const onPeerHandshake = callbacks?.onPeerHandshake;
		const handshakeTimeoutMs = callbacks?.handshakeTimeoutMs;
		if (!appId) throw mkErr("config map is missing appId field");
		if (!roomId) throw mkErr("roomId argument required");
		if (handshakeTimeoutMs !== void 0 && (!Number.isFinite(handshakeTimeoutMs) || handshakeTimeoutMs <= 0)) throw mkErr("handshakeTimeoutMs must be a positive number");
		if (occupiedRooms[appId]?.[roomId]) return occupiedRooms[appId][roomId];
		ensureRoomPresenceHandler(appId);
		const rootTopicPlaintext = topicPath(libName, appId, roomId);
		const rootTopicP = sha1(rootTopicPlaintext);
		const selfTopicP = sha1(topicPath(rootTopicPlaintext, selfId));
		const key = genKey(config.password ?? "", appId, roomId);
		const roomNamespacePromise = deriveRoomNamespace(appId, roomId);
		const sharedPeerIdleMs = config._test_only_sharedPeerIdleMs ?? sharedPeerIdleMsDefault;
		let didLeaveRoom = false;
		const withKey = (f) => async (signal) => ({
			type: signal.type,
			sdp: await f(key, signal.sdp)
		});
		const toPlain = withKey(decrypt);
		const toCipher = withKey(encrypt);
		const sharedPeerMap = sharedPeers.getMap(appId);
		const makeOffer = () => peer_default(true, config);
		let reannounceOnDisconnect = false;
		offerPool ||= new OfferPool(makeOffer);
		const pool = offerPool;
		const encryptOffer = async (peer) => {
			const plainOffer = await peer.getOffer(Date.now() - peer.created > offerTtl);
			if (!plainOffer || plainOffer.type !== "offer") throw mkErr("failed to get offer for peer");
			return (await toCipher(plainOffer)).sdp;
		};
		const attachSharedPeerToRoom = (peerId, shared) => {
			const state = getState(ctx.peerStates, peerId);
			state.answeringExpiryTimer = resetTimer(state.answeringExpiryTimer);
			state.answeringPeer = null;
			const { proxy, isNew } = sharedPeers.bind(roomId, roomNamespacePromise, shared, { onDetach: () => {
				const current = ctx.peerStates[peerId];
				if (current?.connectedPeer === shared.peer) {
					current.connectedPeer = null;
					current.connectedPeerUnhealthySinceMs = null;
					updateStatus(current);
				}
			} });
			state.connectedPeer = shared.peer;
			state.connectedPeerUnhealthySinceMs = null;
			updateStatus(state);
			if (isNew) onPeerConnect(proxy, peerId);
			resetOfferState(state, pool);
		};
		const connectPeer = (peer, peerId, _relayId) => {
			if (didLeaveRoom) {
				peer.destroy();
				return;
			}
			const state = getState(ctx.peerStates, peerId);
			if (state.connectedPeer) {
				const shared = sharedPeerMap[peerId];
				if (shared && state.connectedPeer === shared.peer && shared.bindings[roomId]) return;
				if (state.connectedPeer !== peer && !peer.isDead) peer.destroy();
				return;
			}
			let shared = sharedPeerMap[peerId];
			if (shared && sharedPeers.getHealth(shared.peer) === "stale") {
				sharedPeers.clear(appId, peerId, { destroyPeer: true });
				shared = void 0;
			}
			if (shared && shared.peer !== peer) {
				if (!peer.isDead) peer.destroy();
				attachSharedPeerToRoom(peerId, shared);
				return;
			}
			const isNewShared = !shared;
			shared ||= sharedPeers.register(appId, peerId, peer, sharedPeerIdleMs);
			attachSharedPeerToRoom(peerId, shared);
			if (isNewShared) advertiseKnownRoomsToShared(appId, shared);
		};
		const disconnectPeer = (peer, peerId) => {
			if (didLeaveRoom) return;
			const state = ctx.peerStates[peerId];
			if (state?.connectedPeer === peer) {
				clearConnectedPeer(state, peerId, "close-event");
				checkDeactivate();
				if (!isPassive && reannounceOnDisconnect) ctx.requeueAnnounce?.();
			}
		};
		const isPassive = Boolean(config.passive);
		let roomRegistration = null;
		let passiveActivationTimeout;
		let deactivateRelayAnnouncements = noOp;
		const checkDeactivate = () => {
			if (!isPassive || !ctx.isActive) return;
			let hasActiveWork = false;
			entries(ctx.peerStates).forEach(([peerId, state]) => {
				if (state.connectedPeer || state.answeringPeer || state.offerInitPromise || state.offerPeer || state.offerRelays.some(Boolean)) hasActiveWork = true;
				else if (state.status === "idle") delete ctx.peerStates[peerId];
			});
			if (!hasActiveWork) {
				ctx.isActive = false;
				passiveActivationTimeout = resetTimer(passiveActivationTimeout);
				announceTimeouts.forEach(resetTimer);
				announceTimeouts.length = 0;
				deactivateRelayAnnouncements();
				if (roomRegistration?.roomToken) advertiseRoomPresenceToAll(appId, roomRegistration.roomToken, false);
			}
		};
		const ctx = {
			appId,
			roomId,
			config,
			peerStates: {},
			rootTopicPlaintext,
			rootTopicP,
			selfTopicP,
			toPlain,
			toCipher,
			isLeaving: () => didLeaveRoom,
			isPassive,
			isActive: !isPassive,
			onJoinError,
			sharedPeers,
			offerPool: pool,
			encryptOffer,
			initPeer: peer_default,
			connectPeer,
			disconnectPeer,
			attachSharedPeerToRoom,
			checkDeactivate,
			announceIntervals: [],
			announceIntervalMs
		};
		const strategyContext = {
			config,
			appId,
			roomId,
			isPassive
		};
		const handleMessage = createSignalHandler(ctx);
		if (!didInit) {
			const initRes = init(config);
			initPromises = (Array.isArray(initRes) ? initRes : [initRes]).map((value) => Promise.resolve(value));
			didInit = true;
			cleanupWatchOnline = config.relayConfig?.manualReconnection ? noOp : watchOnline();
		}
		if (!isPassive && !pool.isActive) pool.warmup();
		ctx.announceIntervals = initPromises.map(() => announceIntervalMs);
		const announceScheduleIntervals = initPromises.map(() => announceIntervalMs);
		const announceAttemptCounts = initPromises.map(() => 0);
		const announceErrorStreaks = initPromises.map(() => 0);
		const announceTimeouts = [];
		const unsubFns = initPromises.map(async (relayP, i) => subscribe(await relayP, await rootTopicP, await selfTopicP, handleMessage(i), (n) => pool.getOffers(n, encryptOffer), strategyContext));
		all([rootTopicP, selfTopicP]).then(([rootTopic, selfTopic]) => {
			if (didLeaveRoom) return;
			const queueAnnounce = async (relay, i) => {
				if (didLeaveRoom) return;
				if (isPassive && !ctx.isActive) return;
				const extra = isPassive ? { passive: true } : void 0;
				let announceResult = void 0;
				try {
					announceResult = await announce(relay, rootTopic, selfTopic, extra, strategyContext);
					announceErrorStreaks[i] = 0;
				} catch (error) {
					const errorStreak = announceErrorStreaks[i] ?? 0;
					if (errorStreak === 0 && config.relayConfig?.warnOnRelayFailure !== false) console.warn(`${libName}: announce failed - ${toErrorMessage(error, "")}`);
					announceErrorStreaks[i] = errorStreak + 1;
				}
				if (didLeaveRoom || isPassive && !ctx.isActive) return;
				if (announceResult && typeof announceResult !== "number" && "stopAnnouncing" in announceResult) return;
				if (typeof announceResult === "number") {
					ctx.announceIntervals[i] = announceResult;
					announceScheduleIntervals[i] = announceResult;
				} else if (announceResult) {
					announceScheduleIntervals[i] = announceResult.nextAnnounceMs;
					reannounceOnDisconnect ||= announceResult.reannounceOnDisconnect === true;
				}
				const announceAttempt = announceAttemptCounts[i] ?? 0;
				announceAttemptCounts[i] = announceAttempt + 1;
				const currentInterval = announceScheduleIntervals[i] ?? announceIntervalMs;
				const warmupDelay = announceWarmupIntervalsMs[announceAttempt];
				announceTimeouts[i] = setTimeout(() => {
					queueAnnounce(relay, i);
				}, typeof warmupDelay === "number" ? Math.min(currentInterval, warmupDelay) : currentInterval);
			};
			deactivateRelayAnnouncements = () => {
				if (!deactivate) return;
				initPromises.forEach(async (relayP) => {
					const relay = await relayP;
					if (!didLeaveRoom) deactivate(relay, rootTopic, selfTopic, strategyContext);
				});
			};
			ctx.requeueAnnounce = () => {
				announceTimeouts.forEach(resetTimer);
				announceTimeouts.length = 0;
				passiveActivationTimeout = resetTimer(passiveActivationTimeout);
				if (!pool.isActive) pool.warmup();
				if (roomRegistration?.roomToken) advertiseRoomPresenceToAll(appId, roomRegistration.roomToken, true);
				passiveActivationTimeout = setTimeout(checkDeactivate, passiveActivationGraceMs);
				initPromises.forEach(async (relayP, i) => {
					const relay = await relayP;
					if (relay && !didLeaveRoom) {
						announceAttemptCounts[i] = 0;
						queueAnnounce(relay, i);
					}
				});
			};
			unsubFns.forEach(async (didSub, i) => {
				await didSub;
				if (didLeaveRoom) return;
				const relay = await initPromises[i];
				if (relay && !didLeaveRoom && (!isPassive || ctx.isActive)) queueAnnounce(relay, i);
			});
		});
		let onPeerConnect = noOp;
		const { compose } = createPasswordHandshake(config.password ?? "", appId, roomId);
		const composedPeerHandshake = compose(onPeerHandshake);
		const roomOptions = {
			...composedPeerHandshake ? { onPeerHandshake: composedPeerHandshake } : {},
			...handshakeTimeoutMs === void 0 ? {} : { handshakeTimeoutMs },
			isPassive,
			onHandshakeError: (peerId, error) => onJoinError?.({
				error: error.replace(/^handshake failed: /, ""),
				appId,
				peerId,
				roomId
			})
		};
		occupiedRooms[appId] ??= {};
		const appRoomRegistrations = getRoomRegistrations(appId);
		const joinedRoom = room_default((f) => onPeerConnect = f, (id) => {
			if (didLeaveRoom) return;
			const state = ctx.peerStates[id];
			if (state?.connectedPeer) {
				state.connectedPeer = null;
				updateStatus(state);
				checkDeactivate();
			}
		}, () => {
			didLeaveRoom = true;
			onPeerConnect = noOp;
			const registration = roomRegistrations[appId]?.[roomId];
			if (registration?.roomToken) {
				advertiseRoomPresenceToAll(appId, registration.roomToken, false);
				delete roomIdsByToken[appId]?.[registration.roomToken];
				if (roomIdsByToken[appId] && !keys(roomIdsByToken[appId]).length) delete roomIdsByToken[appId];
			}
			if (roomRegistrations[appId]) {
				delete roomRegistrations[appId][roomId];
				if (!keys(roomRegistrations[appId]).length) delete roomRegistrations[appId];
			}
			entries(ctx.peerStates).forEach(([peerId, state]) => {
				state.answeringExpiryTimer = resetTimer(state.answeringExpiryTimer);
				if (state.connectedPeer && !state.connectedPeer.isDead) {
					const shared = sharedPeerMap[peerId];
					if (!shared || shared.peer !== state.connectedPeer) state.connectedPeer.destroy();
				}
				if (state.answeringPeer && !state.answeringPeer.isDead) state.answeringPeer.destroy();
				resetOfferState(state, pool);
				state.connectedPeer = null;
				state.answeringPeer = null;
				updateStatus(state);
			});
			if (occupiedRooms[appId]) {
				delete occupiedRooms[appId][roomId];
				if (keys(occupiedRooms[appId]).length === 0) delete occupiedRooms[appId];
			}
			announceTimeouts.forEach(resetTimer);
			passiveActivationTimeout = resetTimer(passiveActivationTimeout);
			unsubFns.forEach(async (f) => {
				(await f)();
			});
			if (hasActiveRooms()) return;
			didInit = false;
			pool.destroy();
			offerPool = null;
			cleanupWatchOnline();
			cleanupRoomPresenceHandler(appId);
		}, roomOptions);
		roomRegistration = {
			roomToken: null,
			roomTokenPromise: roomNamespacePromise,
			attachSharedPeerToRoom,
			shouldAdvertise: () => !isPassive || ctx.isActive
		};
		appRoomRegistrations[roomId] = roomRegistration;
		roomNamespacePromise.then((roomToken) => {
			const registration = roomRegistration;
			if (!registration || didLeaveRoom || roomRegistrations[appId]?.[roomId] !== registration) return;
			registration.roomToken = roomToken;
			getRoomIdsByToken(appId)[roomToken] = roomId;
			values(sharedPeerMap).forEach((shared) => {
				if (shared.remoteRoomTokens.has(roomToken)) attachSharedPeerToRoom(shared.peerId, shared);
			});
			if (!isPassive || ctx.isActive) advertiseRoomPresenceToAll(appId, roomToken, true);
		});
		return occupiedRooms[appId][roomId] = joinedRoom;
	};
};
//#endregion
export { strategy_default as default };

