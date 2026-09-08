import { fromJson, mkErr, selfId, toJson } from "./utils.mjs";
import strategy_default from "./strategy.mjs";
//#region src/topic-strategy.ts
const signalKeys = [
	"offer",
	"answer",
	"candidate"
];
const defaultSteadyAnnounceIntervalMs = 6e4;
const toPayload = (msg) => {
	if (typeof msg === "string") try {
		const parsed = fromJson(msg);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
	return msg;
};
const getString = (payload, key) => typeof payload[key] === "string" && payload[key] ? payload[key] : void 0;
const hasInvalidSignalField = (payload) => signalKeys.some((key) => key in payload && (typeof payload[key] !== "string" || payload[key] === ""));
const shouldActivatePassiveRoom = (msg) => {
	const payload = toPayload(msg);
	if (!payload || hasInvalidSignalField(payload)) return false;
	const peerId = getString(payload, "peerId");
	return Boolean(peerId && peerId !== selfId && payload["passive"] !== true && !getString(payload, "answer") && !getString(payload, "candidate"));
};
const requireContext = (context) => {
	if (!context) throw mkErr("topic strategy missing room context");
	return context;
};
const subscriptionContext = (context, kind, rootTopic, selfTopic) => ({
	kind,
	appId: context.appId,
	roomId: context.roomId,
	rootTopic,
	selfTopic
});
const publishContext = (context, kind, rootTopic, selfTopic) => ({
	kind,
	appId: context.appId,
	roomId: context.roomId,
	rootTopic,
	selfTopic
});
var topic_strategy_default = ({ steadyAnnounceIntervalMs = defaultSteadyAnnounceIntervalMs, reannounceOnDisconnect = true, init, subscribeTopic, publishTopic, unpublishTopic }) => strategy_default({
	init,
	subscribe: async (relay, rootTopic, selfTopic, onMessage, _getOffers, rawContext) => {
		const context = requireContext(rawContext);
		const signalPeer = (peerTopic, signal) => void publishTopic(relay, peerTopic, signal, publishContext(context, "signal", rootTopic, selfTopic));
		let selfCleanup = null;
		let selfCleanupDone = false;
		let selfSubscriptionP = null;
		let didCleanup = false;
		const cleanupSelf = (cleanup) => {
			if (selfCleanupDone) return;
			selfCleanupDone = true;
			cleanup();
		};
		const ensureSelfSubscription = () => {
			if (!selfSubscriptionP) selfSubscriptionP = Promise.resolve(subscribeTopic(relay, selfTopic, (topic, msg) => {
				if (!didCleanup) onMessage(topic, msg, signalPeer);
			}, subscriptionContext(context, "self", rootTopic, selfTopic))).then((cleanup) => {
				selfCleanup = cleanup;
				if (didCleanup) cleanupSelf(cleanup);
			});
			return selfSubscriptionP;
		};
		if (!context.isPassive) await ensureSelfSubscription();
		const rootCleanup = await subscribeTopic(relay, rootTopic, async (topic, msg) => {
			if (didCleanup) return;
			if (context.isPassive && shouldActivatePassiveRoom(msg)) await ensureSelfSubscription();
			if (!didCleanup) await onMessage(topic, msg, signalPeer);
		}, subscriptionContext(context, "root", rootTopic, selfTopic));
		return () => {
			didCleanup = true;
			if (selfCleanup) cleanupSelf(selfCleanup);
			rootCleanup();
		};
	},
	announce: async (relay, rootTopic, selfTopic, extraPayload, rawContext) => {
		const context = requireContext(rawContext);
		const result = await publishTopic(relay, rootTopic, toJson({
			peerId: selfId,
			...extraPayload
		}), publishContext(context, "announce", rootTopic, selfTopic));
		return typeof result === "number" || result !== void 0 && "stopAnnouncing" in result ? result : {
			nextAnnounceMs: result?.nextAnnounceMs ?? steadyAnnounceIntervalMs,
			reannounceOnDisconnect: result?.reannounceOnDisconnect ?? reannounceOnDisconnect
		};
	},
	...unpublishTopic ? { deactivate: (relay, rootTopic, selfTopic, rawContext) => {
		const context = requireContext(rawContext);
		return unpublishTopic(relay, rootTopic, publishContext(context, "announce", rootTopic, selfTopic));
	} } : {}
});
//#endregion
export { topic_strategy_default as default };

