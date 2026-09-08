// Vendored from @trystero-p2p/torrent — the bare "@trystero-p2p/core"
// specifier below was rewritten to a relative path since this is loaded
// directly as a static ES module (no bundler/import map involved).
import { createRelayManager, createStrategy, entries, fromJson, genId, getRelays, keys, libName, makeSocket, pauseRelayReconnection, resumeRelayReconnection, selfId, sha1, toJson } from "./core/index.mjs";
//#region src/index.ts
const relayManager = createRelayManager((client) => client.socket);
const topicToInfoHash = {};
const infoHashToTopic = {};
const announceFns = relayManager.scoped();
const subscriptionTokens = relayManager.scoped();
const trackerAnnounceMs = relayManager.scoped();
const handledSignals = {};
const msgHandlers = relayManager.scoped();
const topicStates = relayManager.scoped();
const roomOutstandingOffers = {};
const roomOfferGenerationPromises = {};
const roomSubscriberCounts = {};
const trackerAction = "announce";
const hashLimit = 20;
const offerPoolSize = 3;
const defaultAnnounceMs = 1e4;
const dormantAnnounceMs = 12e4;
const offerRetentionMs = 12e4;
const signalDedupeWindowMs = 4e3;
const defaultRedundancy = 3;
const getInfoHash = async (topic) => {
	if (topicToInfoHash[topic]) return topicToInfoHash[topic];
	const hash = (await sha1(topic)).slice(0, hashLimit);
	topicToInfoHash[topic] = hash;
	infoHashToTopic[hash] = topic;
	return hash;
};
const send = async (client, topic, payload) => client.send(toJson({
	action: trackerAction,
	info_hash: await getInfoHash(topic),
	peer_id: selfId,
	...payload
}));
const warn = (url, msg, didFail = false) => console.warn(`${libName}: torrent tracker ${didFail ? "failure" : "warning"} from ${url} - ${msg}`);
const getRoomOutstandingOffers = (rootTopic) => roomOutstandingOffers[rootTopic] ??= {};
const deleteRoomOfferBookkeeping = (rootTopic) => {
	delete roomOutstandingOffers[rootTopic];
	delete roomOfferGenerationPromises[rootTopic];
};
const claimOutstandingOffer = (rootTopic, offerId) => {
	const outstandingOffers = roomOutstandingOffers[rootTopic];
	const offer = outstandingOffers?.[offerId];
	if (!offer) return;
	delete outstandingOffers[offerId];
	offer.claim?.();
	if (!keys(outstandingOffers).length && !roomSubscriberCounts[rootTopic]) deleteRoomOfferBookkeeping(rootTopic);
	return offer;
};
const reclaimOutstandingOffer = (rootTopic, offerId) => {
	const outstandingOffers = roomOutstandingOffers[rootTopic];
	const offer = outstandingOffers?.[offerId];
	if (!offer) return;
	delete outstandingOffers[offerId];
	offer.reclaim?.();
	if (!keys(outstandingOffers).length && !roomSubscriberCounts[rootTopic]) deleteRoomOfferBookkeeping(rootTopic);
};
const reclaimAllOutstandingOffers = (rootTopic) => {
	keys(getRoomOutstandingOffers(rootTopic)).forEach((offerId) => reclaimOutstandingOffer(rootTopic, offerId));
	deleteRoomOfferBookkeeping(rootTopic);
};
const pruneOutstandingOffers = (rootTopic) => {
	const now = Date.now();
	entries(getRoomOutstandingOffers(rootTopic)).forEach(([offerId, offer]) => {
		if (now - offer.createdAt > offerRetentionMs) reclaimOutstandingOffer(rootTopic, offerId);
	});
};
const ensureOutstandingOffers = async (rootTopic, getOffers) => {
	while (roomOfferGenerationPromises[rootTopic]) await roomOfferGenerationPromises[rootTopic];
	const nextPromise = (async () => {
		pruneOutstandingOffers(rootTopic);
		const outstandingOffers = getRoomOutstandingOffers(rootTopic);
		const outstandingCount = keys(outstandingOffers).length;
		const missingOffers = Math.max(0, offerPoolSize - outstandingCount);
		if (missingOffers > 0) (await getOffers(missingOffers)).forEach((peerAndOffer) => {
			outstandingOffers[genId(hashLimit)] = {
				...peerAndOffer,
				createdAt: Date.now()
			};
		});
	})().finally(() => {
		if (roomOfferGenerationPromises[rootTopic] === nextPromise) delete roomOfferGenerationPromises[rootTopic];
	});
	roomOfferGenerationPromises[rootTopic] = nextPromise;
	await nextPromise;
	return getRoomOutstandingOffers(rootTopic);
};
const joinRoomStrategy = createStrategy({
	init: (config) => getRelays(config, defaultRelayUrls, defaultRedundancy).map((rawUrl) => {
		const client = relayManager.register(rawUrl, () => makeSocket(rawUrl, (rawData) => {
			const data = fromJson(rawData);
			const errMsg = data["failure reason"];
			const warnMsg = data["warning message"];
			const { interval } = data;
			const topic = data.info_hash ? infoHashToTopic[data.info_hash] : void 0;
			if (errMsg) {
				if (config.relayConfig?.warnOnRelayFailure !== false) warn(client.url, errMsg, true);
				return;
			}
			if (warnMsg && config.relayConfig?.warnOnRelayFailure !== false) warn(client.url, warnMsg);
			if (interval && topic && announceFns.forKey(rawUrl)[topic]) trackerAnnounceMs.forKey(rawUrl)[topic] = Math.min(Math.max(interval * 1e3, defaultAnnounceMs), offerRetentionMs);
			if ((data.offer || data.answer) && topic && data.offer_id) {
				if (data.peer_id === selfId) return;
				const signalKey = `${topic}:${data.offer ? "offer" : "answer"}:${data.offer_id}:${data.peer_id ?? ""}`;
				const nowMs = Date.now();
				const lastHandledMs = handledSignals[signalKey];
				if (typeof lastHandledMs === "number" && nowMs - lastHandledMs < signalDedupeWindowMs) return;
				handledSignals[signalKey] = nowMs;
				entries(handledSignals).forEach(([key, handledAtMs]) => {
					if (nowMs - handledAtMs > signalDedupeWindowMs * 6) delete handledSignals[key];
				});
				msgHandlers.forKey(rawUrl)[topic]?.(data);
			}
		}, () => Object.values(announceFns.forKey(rawUrl)).forEach((announce) => void announce())));
		return client.ready;
	}),
	subscribe: (client, rootTopic, _, onMessage, getOffers, context) => {
		const handlers = msgHandlers.forRelay(client);
		const relayFns = announceFns.forRelay(client);
		const relayAnnounceMs = trackerAnnounceMs.forRelay(client);
		const activeTokens = subscriptionTokens.forRelay(client);
		const states = topicStates.forRelay(client);
		const subscriptionToken = Symbol(rootTopic);
		activeTokens[rootTopic] = subscriptionToken;
		roomSubscriberCounts[rootTopic] = (roomSubscriberCounts[rootTopic] ?? 0) + 1;
		const topicHandler = (data) => {
			if (data.offer && data.peer_id && data.offer_id) onMessage(rootTopic, {
				offer: data.offer.sdp,
				peerId: data.peer_id,
				hasOutgoingOffer: keys(getRoomOutstandingOffers(rootTopic)).length > 0
			}, (_, signal) => void send(client, rootTopic, {
				answer: {
					type: "answer",
					sdp: fromJson(signal).answer
				},
				offer_id: data.offer_id,
				to_peer_id: data.peer_id
			}));
			else if (data.answer && data.offer_id && data.peer_id) {
				const offer = claimOutstandingOffer(rootTopic, data.offer_id);
				if (offer) onMessage(rootTopic, {
					answer: data.answer.sdp,
					peerId: data.peer_id,
					peer: offer.peer
				}, () => {});
			}
		};
		handlers[rootTopic] = topicHandler;
		let passiveAnnounceTimeout;
		const stopPassiveAnnouncements = () => {
			clearTimeout(passiveAnnounceTimeout);
			passiveAnnounceTimeout = void 0;
		};
		const topicState = {
			announce: async () => {
				if (activeTokens[rootTopic] !== subscriptionToken) return;
				if (!topicState.isActive) {
					send(client, rootTopic, {
						left: 0,
						numwant: offerPoolSize,
						offers: []
					});
					return;
				}
				const offers = entries(await ensureOutstandingOffers(rootTopic, getOffers)).map(([id, { offer }]) => ({
					offer_id: id,
					offer: {
						type: "offer",
						sdp: offer
					}
				}));
				send(client, rootTopic, {
					numwant: offerPoolSize,
					offers
				});
			},
			isActive: !context?.isPassive,
			startPassiveAnnouncements: () => {
				stopPassiveAnnouncements();
				if (activeTokens[rootTopic] !== subscriptionToken || topicState.isActive) return;
				topicState.announce();
				passiveAnnounceTimeout = setTimeout(topicState.startPassiveAnnouncements, Math.max(relayAnnounceMs[rootTopic] ?? dormantAnnounceMs, dormantAnnounceMs));
			},
			stopPassiveAnnouncements
		};
		relayAnnounceMs[rootTopic] = defaultAnnounceMs;
		const { announce } = topicState;
		relayFns[rootTopic] = announce;
		states[rootTopic] = topicState;
		if (!topicState.isActive) topicState.startPassiveAnnouncements();
		return () => {
			topicState.stopPassiveAnnouncements();
			roomSubscriberCounts[rootTopic] = Math.max(0, (roomSubscriberCounts[rootTopic] ?? 1) - 1);
			if (!roomSubscriberCounts[rootTopic]) delete roomSubscriberCounts[rootTopic];
			if (activeTokens[rootTopic] !== subscriptionToken) {
				if (!roomSubscriberCounts[rootTopic]) {
					reclaimAllOutstandingOffers(rootTopic);
					delete states[rootTopic];
				}
				return;
			}
			if (handlers[rootTopic] === topicHandler) delete handlers[rootTopic];
			if (relayFns[rootTopic] === announce) delete relayFns[rootTopic];
			delete relayAnnounceMs[rootTopic];
			delete activeTokens[rootTopic];
			if (states[rootTopic] === topicState) delete states[rootTopic];
			if (!roomSubscriberCounts[rootTopic]) reclaimAllOutstandingOffers(rootTopic);
		};
	},
	announce: (client, rootTopic) => {
		const state = topicStates.forRelay(client)[rootTopic];
		const fn = announceFns.forRelay(client)[rootTopic];
		if (state) {
			state.stopPassiveAnnouncements();
			state.isActive = true;
		}
		if (fn) fn();
		return trackerAnnounceMs.forRelay(client)[rootTopic] ?? defaultAnnounceMs;
	},
	deactivate: (client, rootTopic) => {
		const state = topicStates.forRelay(client)[rootTopic];
		if (state) state.isActive = false;
		reclaimAllOutstandingOffers(rootTopic);
		state?.startPassiveAnnouncements();
	}
});
const joinRoom = (config, roomId, callbacks) => joinRoomStrategy({
	...config,
	trickleIce: config.trickleIce ?? false
}, roomId, callbacks);
const getRelaySockets = relayManager.getSockets;
const defaultRelayUrls = [
	"open.ftorrent.com",
	"tracker.webtorrent.dev",
	"tracker.openwebtorrent.com",
	"tracker.btorrent.xyz",
	"tracker.files.fm:7073/announce"
].map((url) => "wss://" + url);
//#endregion
export { defaultRelayUrls, getRelaySockets, joinRoom, pauseRelayReconnection, resumeRelayReconnection, selfId };

