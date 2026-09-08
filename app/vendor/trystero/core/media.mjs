import { genId } from "./utils.mjs";
//#region src/media.ts
const toPendingMediaMeta = (value) => {
	if (value && typeof value === "object" && !Array.isArray(value) && typeof value.k === "string") return {
		key: value.k,
		...typeof value.s === "string" ? { streamId: value.s } : {},
		...typeof value.t === "string" ? { trackId: value.t } : {},
		...Object.hasOwn(value, "m") ? { metadata: value.m } : {}
	};
	return null;
};
const makeKeyGetter = (map) => (item) => {
	let key = map.get(item);
	if (!key) {
		key = genId(20);
		map.set(item, key);
	}
	return key;
};
const createMediaIdentityCache = () => {
	const localStreamKeys = /* @__PURE__ */ new WeakMap();
	const localTrackKeys = /* @__PURE__ */ new WeakMap();
	const remoteStreamsByKey = /* @__PURE__ */ new Map();
	const remoteStreamsById = /* @__PURE__ */ new Map();
	const remoteTracksByKey = /* @__PURE__ */ new Map();
	const remoteTracksById = /* @__PURE__ */ new Map();
	return {
		getStreamKey: makeKeyGetter(localStreamKeys),
		getTrackKey: makeKeyGetter(localTrackKeys),
		rememberRemoteStream: (key, stream, streamId) => {
			remoteStreamsByKey.set(key, stream);
			if (streamId) remoteStreamsById.set(streamId, stream);
		},
		getRemoteStream: (key, streamId) => remoteStreamsByKey.get(key) ?? (streamId ? remoteStreamsById.get(streamId) : void 0),
		rememberRemoteTrack: (key, track, stream, trackId, streamId) => {
			const ref = {
				track,
				stream
			};
			remoteTracksByKey.set(key, ref);
			if (trackId) remoteTracksById.set(trackId, ref);
			if (streamId) remoteStreamsById.set(streamId, stream);
		},
		getRemoteTrack: (key, trackId) => remoteTracksByKey.get(key) ?? (trackId ? remoteTracksById.get(trackId) : void 0),
		clearRemote: () => {
			remoteStreamsByKey.clear();
			remoteStreamsById.clear();
			remoteTracksByKey.clear();
			remoteTracksById.clear();
		}
	};
};
const createMediaManager = ({ iterate, isActive, getSharedMediaPeer }) => {
	const pendingStreamMetas = {};
	const pendingTrackMetas = {};
	const localMedia = createMediaIdentityCache();
	const listeners = {
		onPeerStream: null,
		onPeerTrack: null
	};
	const emitStream = (id, key, stream, metadata) => {
		if (!isActive(id)) return;
		getSharedMediaPeer(id)?.__trysteroMedia?.rememberRemoteStream(key, stream, typeof stream.id === "string" ? stream.id : void 0);
		listeners.onPeerStream?.(stream, id, metadata);
	};
	const emitTrack = (id, key, track, stream, metadata) => {
		if (!isActive(id)) return;
		getSharedMediaPeer(id)?.__trysteroMedia?.rememberRemoteTrack(key, track, stream, typeof track.id === "string" ? track.id : void 0, typeof stream.id === "string" ? stream.id : void 0);
		listeners.onPeerTrack?.(track, stream, id, metadata);
	};
	const applyMediaOp = (targets, key, metadata, sendMeta, op, mediaIds = {}) => {
		const payload = {
			k: key,
			...mediaIds,
			...metadata === void 0 ? {} : { m: metadata }
		};
		return iterate(targets, async (id, peer) => {
			await sendMeta(payload, id);
			op(peer);
		});
	};
	return {
		addStream: (stream, options, sendMeta) => applyMediaOp(options.target, localMedia.getStreamKey(stream), options.metadata, sendMeta, (peer) => peer.addStream(stream), { s: stream.id }),
		removeStream: (stream, target) => {
			iterate(target, (_, peer) => peer.removeStream(stream));
		},
		addTrack: (track, stream, options, sendMeta) => applyMediaOp(options.target, localMedia.getTrackKey(track), options.metadata, sendMeta, (peer) => peer.addTrack(track, stream), {
			s: stream.id,
			t: track.id
		}),
		removeTrack: (track, target) => {
			iterate(target, (_, peer) => peer.removeTrack(track));
		},
		replaceTrack: (oldTrack, newTrack, options, sendMeta) => applyMediaOp(options.target, localMedia.getTrackKey(newTrack), options.metadata, sendMeta, (peer) => peer.replaceTrack(oldTrack, newTrack), { t: oldTrack.id }),
		receiveStreamMeta: (meta, id) => {
			if (!isActive(id)) return;
			const parsed = toPendingMediaMeta(meta);
			if (!parsed) return;
			const cached = getSharedMediaPeer(id)?.__trysteroMedia?.getRemoteStream(parsed.key, parsed.streamId);
			if (cached) {
				emitStream(id, parsed.key, cached, parsed.metadata);
				return;
			}
			(pendingStreamMetas[id] ??= []).push(parsed);
		},
		receiveTrackMeta: (meta, id) => {
			if (!isActive(id)) return;
			const parsed = toPendingMediaMeta(meta);
			if (!parsed) return;
			const cached = getSharedMediaPeer(id)?.__trysteroMedia?.getRemoteTrack(parsed.key, parsed.trackId);
			if (cached) {
				emitTrack(id, parsed.key, cached.track, cached.stream, parsed.metadata);
				return;
			}
			(pendingTrackMetas[id] ??= []).push(parsed);
		},
		receiveRemoteStream: (id, stream) => {
			if (!isActive(id)) return;
			const next = pendingStreamMetas[id]?.shift();
			if (!next) return;
			emitStream(id, next.key, stream, next.metadata);
		},
		receiveRemoteTrack: (id, track, stream) => {
			if (!isActive(id)) return;
			const next = pendingTrackMetas[id]?.shift();
			if (!next) return;
			emitTrack(id, next.key, track, stream, next.metadata);
		},
		clearPeer: (id) => {
			delete pendingStreamMetas[id];
			delete pendingTrackMetas[id];
		},
		get onPeerStream() {
			return listeners.onPeerStream;
		},
		set onPeerStream(handler) {
			listeners.onPeerStream = handler;
		},
		get onPeerTrack() {
			return listeners.onPeerTrack;
		},
		set onPeerTrack(handler) {
			listeners.onPeerTrack = handler;
		}
	};
};
//#endregion
export { createMediaIdentityCache, createMediaManager };

