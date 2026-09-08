import { all, candidateType, fromJson, genId, mkErr, resetTimer, selfId, toJson, topicPath } from "./utils.mjs";
import { sha1 } from "./crypto.mjs";
import { offerTtl } from "./offer-pool.mjs";
import { getConnectedPeerHealth } from "./shared-peer.mjs";
//#region src/signal-handler.ts
const offerPostAnswerTtlMs = 23333;
const offerIdSize = 12;
const disconnectedPeerGraceMs = 7533;
const answeringTtlMs = 23333;
const legacyCandidateKey = "__legacy__";
const offerRelayPlaceholder = "offer-placeholder";
const signalKeys = [
	"offer",
	"answer",
	"candidate"
];
const toPayload = (msg) => {
	if (typeof msg === "string") try {
		const parsed = fromJson(msg);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
	return msg && typeof msg === "object" ? msg : null;
};
const getString = (payload, key) => typeof payload[key] === "string" && payload[key] ? payload[key] : void 0;
const hasInvalidSignalField = (payload) => signalKeys.some((key) => key in payload && (typeof payload[key] !== "string" || payload[key] === ""));
const publishCipheredSignalingMessage = (ctx, signal, peerTopic, signalPeer, buildPayload, stillValid) => {
	ctx.toCipher(signal).then((encryptedSignal) => {
		if (ctx.isLeaving() || !stillValid()) return;
		signalPeer(peerTopic, toJson(buildPayload(encryptedSignal.sdp)));
	});
};
const makeState = () => ({
	status: "idle",
	offerPeer: null,
	offerId: null,
	offerSdp: null,
	offerInitPromise: null,
	offerAnswered: false,
	offerRelays: [],
	offerSignalRelays: [],
	offerSignalBacklog: [],
	offerRelayTimers: [],
	offerExpiryTimer: null,
	connectedPeer: null,
	connectedPeerUnhealthySinceMs: null,
	answeringExpiryTimer: null,
	answeringPeer: null,
	answerSent: false,
	connectionErrorReported: false,
	pendingCandidates: {}
});
const hasTurnServer = (config) => {
	return [...config.turnConfig ?? [], ...config.rtcConfig?.iceServers ?? []].some(({ urls }) => {
		return (Array.isArray(urls) ? urls : [urls]).some((url) => /^turns?:/i.test(url));
	});
};
const getSdpExchangeConnectionError = (peerId, config) => `could not connect to peer ${peerId} after exchanging SDP; ${hasTurnServer(config) ? "check that your TURN server URLs and credentials are reachable by both peers" : "configure TURN servers with turnConfig or rtcConfig.iceServers"}`;
const reportSdpExchangeConnectionFailure = (ctx, state, peerId) => {
	if (ctx.isLeaving() || state.connectedPeer || state.connectionErrorReported) return;
	state.connectionErrorReported = true;
	ctx.onJoinError?.({
		error: getSdpExchangeConnectionError(peerId, ctx.config),
		appId: ctx.appId,
		peerId,
		roomId: ctx.roomId
	});
};
const getState = (peerStates, peerId) => peerStates[peerId] ??= makeState();
const updateStatus = (state) => {
	if (state.connectedPeer) state.status = "connected";
	else if (state.answeringPeer) state.status = "answering";
	else if (state.offerPeer || state.offerRelays.some(Boolean)) state.status = "offering";
	else state.status = "idle";
};
const clearAnswering = (state, peer) => {
	if (state.answeringPeer === peer) {
		state.answeringExpiryTimer = resetTimer(state.answeringExpiryTimer);
		state.answeringPeer = null;
		state.answerSent = false;
		updateStatus(state);
	}
};
const clearConnectedPeer = (state, peerId, _reason) => {
	if (!state.connectedPeer) return;
	if (!state.connectedPeer.isDead) state.connectedPeer.destroy();
	state.connectedPeer = null;
	state.connectedPeerUnhealthySinceMs = null;
	updateStatus(state);
};
const clearOfferRelay = (state, relayId) => {
	state.offerRelayTimers[relayId] = resetTimer(state.offerRelayTimers[relayId]);
	if (state.offerRelays[relayId]) {
		state.offerRelays[relayId] = void 0;
		updateStatus(state);
	}
};
const clearOfferRelayIfPlaceholder = (state, relayId) => {
	if (state?.offerRelays[relayId] === offerRelayPlaceholder) clearOfferRelay(state, relayId);
};
const hasRemoteDescription = (peer) => {
	if (peer.isDead || peer.connection.connectionState === "closed") return true;
	try {
		return Boolean(peer.connection.remoteDescription);
	} catch {
		return true;
	}
};
const resetOfferState = (state, offerPool) => {
	const previousOfferAnswered = state.offerAnswered;
	state.offerExpiryTimer = resetTimer(state.offerExpiryTimer);
	state.offerInitPromise = null;
	state.offerRelays.forEach((_, relayId) => clearOfferRelay(state, relayId));
	state.offerRelays = [];
	state.offerSignalRelays = [];
	state.offerRelayTimers = [];
	state.offerSignalBacklog = [];
	if (state.offerPeer && state.offerPeer !== state.connectedPeer) if (previousOfferAnswered || hasRemoteDescription(state.offerPeer)) {
		if (!state.offerPeer.isDead) state.offerPeer.destroy();
	} else offerPool.recycle(state.offerPeer);
	state.offerPeer = null;
	state.offerId = null;
	state.offerSdp = null;
	state.offerAnswered = false;
	state.connectionErrorReported = false;
	updateStatus(state);
};
const scheduleAnsweringExpiry = (ctx, state, peerId, peer) => {
	resetTimer(state.answeringExpiryTimer);
	state.answeringExpiryTimer = setTimeout(() => {
		const current = ctx.peerStates[peerId];
		if (!current || current.connectedPeer || current.answeringPeer !== peer) return;
		if (current.answerSent) reportSdpExchangeConnectionFailure(ctx, current, peerId);
		peer.destroy();
		clearAnswering(current, peer);
		ctx.checkDeactivate();
	}, answeringTtlMs);
};
const flushBufferedCandidates = async (state, peer, offerId) => {
	const bufferKeys = offerId ? [offerId, legacyCandidateKey] : [legacyCandidateKey];
	for (const key of bufferKeys) {
		const buffered = state.pendingCandidates[key];
		if (!buffered?.length) continue;
		delete state.pendingCandidates[key];
		for (const candidate of buffered) await peer.signal(candidate);
	}
};
const scheduleOfferExpiry = (ctx, state, peerId, ttlMs = offerTtl) => {
	resetTimer(state.offerExpiryTimer);
	const offerId = state.offerId;
	state.offerExpiryTimer = setTimeout(() => {
		const current = ctx.peerStates[peerId];
		if (!current || current.connectedPeer || current.offerId !== offerId) return;
		if (current.offerAnswered) reportSdpExchangeConnectionFailure(ctx, current, peerId);
		resetOfferState(current, ctx.offerPool);
		ctx.checkDeactivate();
	}, ttlMs);
};
const ensureOffer = (ctx, state, peerId, relayId) => {
	if (state.offerPeer && state.offerId && state.offerSdp) return Promise.resolve({
		peer: state.offerPeer,
		offer: state.offerSdp,
		offerId: state.offerId
	});
	if (state.offerInitPromise) return state.offerInitPromise;
	state.offerInitPromise = (async () => {
		const firstOffer = (await ctx.offerPool.checkout(1, false, ctx.encryptOffer))[0];
		if (!firstOffer) throw mkErr("failed to allocate offer peer");
		const { peer, offer } = firstOffer;
		state.offerPeer = peer;
		state.offerId = genId(offerIdSize);
		state.offerSdp = offer;
		state.offerAnswered = false;
		state.connectionErrorReported = false;
		state.offerSignalBacklog = [];
		updateStatus(state);
		const onOfferPeerClosedOrError = () => {
			if (state.offerPeer === peer && !state.connectedPeer) {
				if (state.offerAnswered) reportSdpExchangeConnectionFailure(ctx, state, peerId);
				resetOfferState(state, ctx.offerPool);
			}
			ctx.disconnectPeer(peer, peerId);
			ctx.checkDeactivate();
		};
		peer.setHandlers({
			connect: () => ctx.connectPeer(peer, peerId, relayId),
			signal: (signal) => {
				if (state.offerPeer !== peer) return;
				state.offerSignalBacklog.push(signal);
				state.offerSignalRelays.forEach((sendSignal) => sendSignal?.(signal));
			},
			close: onOfferPeerClosedOrError,
			error: onOfferPeerClosedOrError
		});
		scheduleOfferExpiry(ctx, state, peerId);
		return {
			peer,
			offer,
			offerId: state.offerId
		};
	})().finally(() => state.offerInitPromise = null);
	return state.offerInitPromise;
};
const handleAnnouncement = async (ctx, relayId, peerId, shared, signalPeer) => {
	if (shared) {
		ctx.attachSharedPeerToRoom(peerId, shared);
		return;
	}
	const state = ctx.peerStates[peerId];
	if (!state || state.connectedPeer || state.answeringPeer || state.offerAnswered) {
		clearOfferRelayIfPlaceholder(state, relayId);
		return;
	}
	if (state.offerRelays[relayId] !== offerRelayPlaceholder) return;
	const [peerTopic, offerInfo] = await all([sha1(topicPath(ctx.rootTopicPlaintext, peerId)), ensureOffer(ctx, state, peerId, relayId)]);
	if (ctx.isLeaving()) return;
	if (state.connectedPeer || state.answeringPeer || state.offerAnswered || state.offerRelays[relayId] !== offerRelayPlaceholder) {
		clearOfferRelayIfPlaceholder(state, relayId);
		return;
	}
	state.offerRelayTimers[relayId] = resetTimer(state.offerRelayTimers[relayId]);
	state.offerRelays[relayId] = true;
	updateStatus(state);
	state.offerRelayTimers[relayId] = setTimeout(() => prunePendingOffer(ctx, peerId, relayId), (ctx.announceIntervals[relayId] ?? ctx.announceIntervalMs) * .9);
	let didSendOffer = false;
	state.offerSignalRelays[relayId] = (signal) => {
		if (!didSendOffer) return;
		if (ctx.isLeaving() || state.connectedPeer || state.offerPeer !== offerInfo.peer || state.offerId !== offerInfo.offerId || signal.type !== "candidate") return;
		publishCipheredSignalingMessage(ctx, signal, peerTopic, signalPeer, (sdp) => ({
			peerId: selfId,
			offerId: offerInfo.offerId,
			candidate: sdp,
			...ctx.isPassive ? { passive: true } : {}
		}), () => !state.connectedPeer && state.offerPeer === offerInfo.peer && state.offerId === offerInfo.offerId);
	};
	signalPeer(peerTopic, toJson({
		peerId: selfId,
		offerId: offerInfo.offerId,
		offer: offerInfo.offer,
		...ctx.isPassive ? { passive: true } : {}
	}));
	didSendOffer = true;
	state.offerSignalBacklog.forEach((signal) => state.offerSignalRelays[relayId]?.(signal));
};
const handleOffer = async (ctx, relayId, peerId, offer, offerId, hasOutgoingOfferHint, signalPeer) => {
	const state = getState(ctx.peerStates, peerId);
	if (state.answeringPeer || state.offerAnswered) return;
	const hasTrackedOutgoingOffer = Boolean(state.offerPeer || state.offerRelays.some(Boolean));
	if ((hasTrackedOutgoingOffer || hasOutgoingOfferHint) && selfId < peerId) return;
	if (hasTrackedOutgoingOffer) resetOfferState(state, ctx.offerPool);
	const answerPeer = ctx.initPeer(false, ctx.config);
	state.answeringPeer = answerPeer;
	state.answerSent = false;
	state.connectionErrorReported = false;
	scheduleAnsweringExpiry(ctx, state, peerId, answerPeer);
	updateStatus(state);
	const onAnswerPeerClosedOrError = () => {
		if (state.answeringPeer === answerPeer && !state.connectedPeer && state.answerSent) reportSdpExchangeConnectionFailure(ctx, state, peerId);
		clearAnswering(state, answerPeer);
		ctx.disconnectPeer(answerPeer, peerId);
		ctx.checkDeactivate();
	};
	answerPeer.setHandlers({
		connect: () => ctx.connectPeer(answerPeer, peerId, relayId),
		close: onAnswerPeerClosedOrError,
		error: onAnswerPeerClosedOrError
	});
	let plainOffer;
	try {
		plainOffer = await ctx.toPlain({
			type: "offer",
			sdp: offer
		});
	} catch {
		clearAnswering(state, answerPeer);
		ctx.onJoinError?.({
			error: "incorrect room password when decrypting offer",
			appId: ctx.appId,
			peerId,
			roomId: ctx.roomId
		});
		return;
	}
	if (answerPeer.isDead) {
		clearAnswering(state, answerPeer);
		return;
	}
	const peerTopic = await sha1(topicPath(ctx.rootTopicPlaintext, peerId));
	if (ctx.isLeaving()) return;
	answerPeer.setHandlers({ signal: (signal) => {
		if (ctx.isLeaving() || state.answeringPeer !== answerPeer || answerPeer.isDead) return;
		if (signal.type !== "answer" && signal.type !== "candidate") return;
		publishCipheredSignalingMessage(ctx, signal, peerTopic, signalPeer, (sdp) => {
			const payloadToSend = { peerId: selfId };
			if (signal.type === "answer") {
				state.answerSent = true;
				payloadToSend["answer"] = sdp;
			} else payloadToSend["candidate"] = sdp;
			if (offerId) payloadToSend["offerId"] = offerId;
			if (ctx.isPassive) payloadToSend["passive"] = true;
			return payloadToSend;
		}, () => state.answeringPeer === answerPeer && !answerPeer.isDead);
	} });
	await answerPeer.signal(plainOffer);
	await flushBufferedCandidates(state, answerPeer, offerId);
};
const handleCandidate = async (ctx, peerId, candidate, offerId, peer) => {
	let plainCandidate;
	try {
		plainCandidate = await ctx.toPlain({
			type: candidateType,
			sdp: candidate
		});
	} catch {
		return;
	}
	const state = getState(ctx.peerStates, peerId);
	const offerPeerMatch = offerId && state?.offerPeer && state.offerId === offerId ? state.offerPeer : null;
	const answeringPeer = state?.answeringPeer ?? null;
	const fallbackOfferPeer = !offerId && state?.offerPeer ? state.offerPeer : null;
	const targetPeer = peer && !peer.isDead ? peer : offerPeerMatch ?? answeringPeer ?? fallbackOfferPeer;
	if (!targetPeer || targetPeer.isDead) {
		const pendingKey = offerId ?? legacyCandidateKey;
		(state.pendingCandidates[pendingKey] ??= []).push(plainCandidate);
		return;
	}
	targetPeer.signal(plainCandidate);
};
const handleAnswer = async (ctx, relayId, peerId, answer, offerId, peer) => {
	let plainAnswer;
	try {
		plainAnswer = await ctx.toPlain({
			type: "answer",
			sdp: answer
		});
	} catch {
		ctx.onJoinError?.({
			error: "incorrect room password when decrypting answer",
			appId: ctx.appId,
			peerId,
			roomId: ctx.roomId
		});
		return;
	}
	if (peer) {
		ctx.offerPool.claimLeased(peer);
		peer.setHandlers({
			connect: () => ctx.connectPeer(peer, peerId, relayId),
			close: () => ctx.disconnectPeer(peer, peerId)
		});
		peer.signal(plainAnswer);
	} else {
		const state = ctx.peerStates[peerId];
		if (!state || !state.offerPeer || state.offerAnswered || offerId && state.offerId && offerId !== state.offerId || state.offerPeer.isDead) return;
		state.offerAnswered = true;
		scheduleOfferExpiry(ctx, state, peerId, offerPostAnswerTtlMs);
		state.offerPeer.signal(plainAnswer);
	}
};
const prunePendingOffer = (ctx, peerId, relayId) => {
	const state = ctx.peerStates[peerId];
	if (!state || state.connectedPeer) return;
	if (state.offerRelays[relayId]) {
		clearOfferRelay(state, relayId);
		ctx.checkDeactivate();
	}
};
const createSignalHandler = (ctx) => (relayId) => async (topic, msg, signalPeer) => {
	if (ctx.isLeaving()) return;
	const payload = toPayload(msg);
	if (!payload || hasInvalidSignalField(payload)) return;
	const peerId = getString(payload, "peerId") ?? "";
	const offer = getString(payload, "offer");
	const answer = getString(payload, "answer");
	const candidate = getString(payload, "candidate");
	const offerId = getString(payload, "offerId");
	const peer = payload["peer"];
	const hasOutgoingOfferHint = payload["hasOutgoingOffer"] === true;
	const remoteIsPassive = payload["passive"] === true;
	if (!peerId || peerId === selfId) return;
	const [rootTopic, selfTopic] = await all([ctx.rootTopicP, ctx.selfTopicP]);
	if (ctx.isLeaving()) return;
	if (topic !== rootTopic && topic !== selfTopic) return;
	if (ctx.isPassive && remoteIsPassive) return;
	if (ctx.isPassive && !ctx.isActive && !answer && !candidate) {
		ctx.isActive = true;
		ctx.requeueAnnounce?.();
	}
	if (ctx.isPassive && !ctx.isActive) return;
	const state = ctx.peerStates[peerId];
	const connectedPeer = state?.connectedPeer;
	if (connectedPeer && state) {
		const health = getConnectedPeerHealth(connectedPeer);
		if (health === "live") {
			state.connectedPeerUnhealthySinceMs = null;
			return;
		}
		if (health === "stale") clearConnectedPeer(state, peerId, "message-from-stale-peer");
		else {
			const nowMs = Date.now();
			const unhealthySinceMs = state.connectedPeerUnhealthySinceMs ?? nowMs;
			state.connectedPeerUnhealthySinceMs = unhealthySinceMs;
			if (nowMs - unhealthySinceMs < disconnectedPeerGraceMs) return;
			clearConnectedPeer(state, peerId, "message-from-prolonged-disconnect");
		}
	}
	let shared = ctx.sharedPeers.get(ctx.appId, peerId);
	if (shared && ctx.sharedPeers.getHealth(shared.peer) === "stale") {
		ctx.sharedPeers.clear(ctx.appId, peerId, { destroyPeer: true });
		shared = void 0;
	}
	const isAnnouncement = Boolean(peerId && !offer && !answer && !candidate);
	if (isAnnouncement && !shared) {
		const announcePeerState = getState(ctx.peerStates, peerId);
		const shouldLeadOffer = selfId < peerId;
		if (announcePeerState.answeringPeer || announcePeerState.connectedPeer || announcePeerState.offerAnswered) return;
		if (!shouldLeadOffer && !announcePeerState.offerPeer) {
			const peerSelfTopic = await sha1(topicPath(ctx.rootTopicPlaintext, peerId));
			if (!ctx.isLeaving() && !announcePeerState.connectedPeer) signalPeer(peerSelfTopic, toJson({ peerId: selfId }));
			return;
		}
		if (announcePeerState.offerRelays[relayId]) return;
		announcePeerState.offerRelays[relayId] = offerRelayPlaceholder;
		updateStatus(announcePeerState);
	}
	if (shared && (offer || answer || candidate)) {
		if (shared.bindings[ctx.roomId]) return;
		ctx.attachSharedPeerToRoom(peerId, shared);
		return;
	}
	if (isAnnouncement) return handleAnnouncement(ctx, relayId, peerId, shared, signalPeer);
	if (offer) return handleOffer(ctx, relayId, peerId, offer, offerId, hasOutgoingOfferHint, signalPeer);
	if (candidate) return handleCandidate(ctx, peerId, candidate, offerId, peer);
	if (answer) return handleAnswer(ctx, relayId, peerId, answer, offerId, peer);
};
//#endregion
export { clearConnectedPeer, createSignalHandler, getState, resetOfferState, updateStatus };

