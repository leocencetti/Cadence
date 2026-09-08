import { all, alloc, decodeBytes, encodeBytes, fromJson, libName, mkErr, noOp, resetTimer, toJson } from "./utils.mjs";
//#region src/action-wire.ts
const TypedArray = Object.getPrototypeOf(Uint8Array);
const typeByteLimit = 32;
const typeIndex = 0;
const nonceIndex = 32;
const tagIndex = 34;
const progressIndex = 35;
const payloadIndex = 36;
const chunkSize = 16 * 2 ** 10 - payloadIndex;
const oneByteMax = 255;
const twoByteMax = 65535;
const buffLowEvent = "bufferedamountlow";
const channelCloseEvent = "close";
const channelErrorEvent = "error";
const backpressureWaitTimeoutMs = 1e4;
const toByteArray = (value) => value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
const waitForBufferedAmountLow = (channel, timeoutMs = backpressureWaitTimeoutMs) => {
	if (channel.readyState !== "open" || channel.bufferedAmount <= channel.bufferedAmountLowThreshold) return Promise.resolve(channel.readyState === "open");
	return new Promise((res) => {
		let settled = false;
		let timeout = null;
		const finish = (didDrain) => {
			if (settled) return;
			settled = true;
			channel.removeEventListener(buffLowEvent, onBufferLow);
			channel.removeEventListener(channelCloseEvent, onCloseOrError);
			channel.removeEventListener(channelErrorEvent, onCloseOrError);
			resetTimer(timeout);
			res(didDrain);
		};
		const onBufferLow = () => finish(true);
		const onCloseOrError = () => finish(false);
		channel.addEventListener(buffLowEvent, onBufferLow);
		channel.addEventListener(channelCloseEvent, onCloseOrError);
		channel.addEventListener(channelErrorEvent, onCloseOrError);
		timeout = setTimeout(() => finish(false), timeoutMs);
		if (channel.readyState !== "open") {
			finish(false);
			return;
		}
		if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) finish(true);
	});
};
const createActionWireManager = ({ getPeer, getPeerIds, canReceiveFromPeer, throwIfAborted }) => {
	const actions = {};
	const actionsCache = {};
	const pendingTransmissions = {};
	const pendingActionPayloads = {};
	const iterate = (targets, f, { includePending = false } = {}) => (targets ? Array.isArray(targets) ? targets : [targets] : getPeerIds(includePending)).flatMap((id) => {
		const peer = getPeer(id, includePending);
		if (!peer) {
			console.warn(`${libName}: no peer with id ${id} found`);
			return [];
		}
		return [Promise.resolve(f(id, peer))];
	});
	const makeInternalAction = (type, options = {}) => {
		const cached = actionsCache[type];
		if (actions[type] && cached) {
			const cachedOptions = actions[type].options;
			if (cachedOptions.sendToPending !== Boolean(options.sendToPending) || cachedOptions.receiveWhilePending !== Boolean(options.receiveWhilePending)) throw mkErr(`action type "${type}" cannot be redefined`);
			return cached;
		}
		if (!type) throw mkErr("action type argument is required");
		const typeBytes = encodeBytes(type);
		if (typeBytes.byteLength > typeByteLimit) throw mkErr(`action type string "${type}" (${typeBytes.byteLength}b) exceeds byte limit (${typeByteLimit}). Hint: choose a shorter name.`);
		const normalizedOptions = {
			sendToPending: Boolean(options.sendToPending),
			receiveWhilePending: Boolean(options.receiveWhilePending)
		};
		const typeBytesPadded = new Uint8Array(typeByteLimit);
		typeBytesPadded.set(typeBytes);
		let nonce = 0;
		actions[type] = {
			onComplete: noOp,
			onProgress: noOp,
			setOnComplete: (f) => {
				actions[type].onComplete = f;
				const pending = pendingActionPayloads[type];
				if (pending?.length) {
					delete pendingActionPayloads[type];
					pending.forEach(({ payload, peerId, metadata }) => f(payload, peerId, metadata));
				}
			},
			setOnProgress: (f) => {
				actions[type].onProgress = f;
			},
			send: async (data, targets, meta, onProgress, signal) => {
				throwIfAborted(signal);
				const dataType = typeof data;
				if (dataType === "undefined") throw mkErr("action data cannot be undefined");
				const isJson = dataType !== "string";
				const isBlob = data instanceof Blob;
				const isBinary = isBlob || data instanceof ArrayBuffer || data instanceof TypedArray;
				const hasMeta = meta !== void 0;
				const buffer = isBinary ? toByteArray(isBlob ? await data.arrayBuffer() : data) : encodeBytes(isJson ? toJson(data) : data);
				const metaEncoded = hasMeta ? encodeBytes(toJson(meta)) : null;
				const chunkTotal = Math.ceil(buffer.byteLength / chunkSize) + (hasMeta ? 1 : 0) || 1;
				const chunks = alloc(chunkTotal, (_, i) => {
					const isLast = i === chunkTotal - 1;
					const isMeta = Boolean(hasMeta && i === 0);
					const chunk = new Uint8Array(payloadIndex + (isMeta ? metaEncoded?.byteLength ?? 0 : isLast ? buffer.byteLength - chunkSize * (chunkTotal - (hasMeta ? 2 : 1)) : chunkSize));
					chunk.set(typeBytesPadded);
					chunk.set([nonce >> 8, nonce & oneByteMax], nonceIndex);
					chunk.set([Number(isLast) | Number(isMeta) << 1 | Number(isBinary) << 2 | Number(isJson) << 3], tagIndex);
					chunk.set([Math.round((i + 1) / chunkTotal * oneByteMax)], progressIndex);
					chunk.set(hasMeta ? isMeta ? metaEncoded ?? /* @__PURE__ */ new Uint8Array() : buffer.subarray((i - 1) * chunkSize, i * chunkSize) : buffer.subarray(i * chunkSize, (i + 1) * chunkSize), payloadIndex);
					return chunk;
				});
				nonce = nonce + 1 & twoByteMax;
				await all(iterate(targets, async (id, peer) => {
					const { channel } = peer;
					let chunkN = 0;
					while (chunkN < chunkTotal) {
						throwIfAborted(signal);
						const chunk = chunks[chunkN];
						if (!chunk) break;
						if (channel && channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
							const didDrain = await waitForBufferedAmountLow(channel);
							throwIfAborted(signal);
							if (!didDrain) break;
						}
						const currentPeer = getPeer(id, normalizedOptions.sendToPending);
						if (!currentPeer || currentPeer !== peer) break;
						peer.sendData(chunk);
						chunkN++;
						const progressByte = chunk[progressIndex] ?? oneByteMax;
						onProgress?.(progressByte / oneByteMax, id, meta);
					}
				}, { includePending: normalizedOptions.sendToPending }));
				return [];
			},
			options: normalizedOptions
		};
		return actionsCache[type] = {
			send: actions[type].send,
			onMessage: actions[type].setOnComplete,
			onProgress: actions[type].setOnProgress
		};
	};
	const handleData = (id, data) => {
		const buffer = new Uint8Array(data);
		const type = decodeBytes(buffer.subarray(typeIndex, nonceIndex)).replaceAll("\0", "");
		const action = actions[type];
		if (!canReceiveFromPeer(id, Boolean(action?.options.receiveWhilePending))) return;
		const nonce = (buffer[nonceIndex] ?? 0) << 8 | (buffer[33] ?? 0);
		const tag = buffer[tagIndex] ?? 0;
		const progress = buffer[progressIndex] ?? 0;
		const payload = buffer.subarray(payloadIndex);
		const isLast = Boolean(tag & 1);
		const isMeta = Boolean(tag & 2);
		const isBinary = Boolean(tag & 4);
		const isJson = Boolean(tag & 8);
		pendingTransmissions[id] ??= {};
		pendingTransmissions[id][type] ??= {};
		const target = pendingTransmissions[id][type][nonce] ??= { chunks: [] };
		if (isMeta) target.meta = fromJson(decodeBytes(payload));
		else target.chunks.push(payload);
		action?.onProgress(progress / oneByteMax, id, target.meta);
		if (!isLast) return;
		const full = new Uint8Array(target.chunks.reduce((a, c) => a + c.byteLength, 0));
		target.chunks.reduce((a, c) => {
			full.set(c, a);
			return a + c.byteLength;
		}, 0);
		delete pendingTransmissions[id][type][nonce];
		const payloadValue = isBinary ? full : isJson ? fromJson(decodeBytes(full)) : decodeBytes(full);
		if (action) {
			action.onComplete(payloadValue, id, target.meta);
			return;
		}
		(pendingActionPayloads[type] ??= []).push({
			payload: payloadValue,
			peerId: id,
			...target.meta === void 0 ? {} : { metadata: target.meta }
		});
	};
	return {
		makeInternalAction,
		handleData,
		clearPeer: (id) => {
			delete pendingTransmissions[id];
		}
	};
};
//#endregion
export { createActionWireManager };

