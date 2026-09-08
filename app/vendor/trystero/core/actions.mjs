import { all, entries, genId, libName, mkErr, resetTimer, toError, toErrorMessage } from "./utils.mjs";
import { createActionWireManager } from "./action-wire.mjs";
//#region src/actions.ts
const requestHandlerBufferMs = 500;
const makeActionError = (kind, message) => {
	const error = mkErr(message);
	error.kind = kind;
	error.name = kind === "aborted" ? "AbortError" : error.name;
	return error;
};
const throwIfAborted = (signal) => {
	if (signal?.aborted) throw makeActionError("aborted", "operation aborted");
};
const getRequestMetadata = (metadata) => {
	if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && typeof metadata.r === "string") return {
		r: metadata.r,
		...Object.hasOwn(metadata, "m") ? { m: metadata.m } : {}
	};
	return null;
};
const getResponseMetadata = (metadata) => {
	if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && typeof metadata.r === "string") return {
		r: metadata.r,
		...typeof metadata.e === "string" ? { e: metadata.e } : {}
	};
	return null;
};
const withMetadata = (context, metadata) => metadata === void 0 ? context : {
	...context,
	metadata
};
const createActionManager = ({ getPeer, getPeerIds, canReceiveFromPeer }) => {
	const publicActions = {};
	const pendingRequestWaiters = {};
	const wire = createActionWireManager({
		getPeer,
		getPeerIds,
		canReceiveFromPeer,
		throwIfAborted
	});
	const makeInternalAction = wire.makeInternalAction;
	const handleData = wire.handleData;
	const clearPendingRequestWaiter = (requestId) => {
		const waiter = pendingRequestWaiters[requestId];
		if (!waiter) return;
		resetTimer(waiter.timer);
		if (waiter.signal && waiter.abortHandler) waiter.signal.removeEventListener("abort", waiter.abortHandler);
		delete pendingRequestWaiters[requestId];
	};
	const rejectPendingRequestsForPeer = (id, error) => {
		entries(pendingRequestWaiters).forEach(([requestId, waiter]) => {
			if (waiter.peerId !== id) return;
			clearPendingRequestWaiter(requestId);
			waiter.reject(error);
		});
	};
	const clearPeer = (id, error) => {
		wire.clearPeer(id);
		rejectPendingRequestsForPeer(id, makeActionError("disconnected", toErrorMessage(error, "peer disconnected")));
	};
	const responseAction = makeInternalAction("@_response");
	responseAction.onMessage((payload, id, metadata) => {
		const parsed = getResponseMetadata(metadata);
		if (!parsed) return;
		const waiter = pendingRequestWaiters[parsed.r];
		if (!waiter || waiter.peerId !== id) return;
		clearPendingRequestWaiter(parsed.r);
		if (parsed.e !== void 0) {
			waiter.reject(makeActionError("rejected", parsed.e));
			return;
		}
		waiter.resolve(payload);
	});
	const makeActionImpl = (type, config) => {
		if (config && "onRequest" in config && config.kind !== "request") throw mkErr("request actions must use kind: \"request\"");
		const kind = config?.kind ?? "message";
		const rawAction = makeInternalAction(type);
		const existingState = publicActions[type];
		if (existingState) {
			if (existingState.kind !== kind) throw mkErr(`action type "${type}" cannot be redefined`);
			return existingState.action;
		}
		const state = {
			kind,
			action: null,
			pendingMessages: [],
			pendingRequests: [],
			onReceiveProgress: config?.onReceiveProgress ?? null
		};
		const toProgressHandler = (handler, metadata) => handler ? (progress, peerId) => handler(progress, withMetadata({ peerId }, metadata)) : void 0;
		const setReceiveProgress = (handler) => {
			state.onReceiveProgress = handler;
		};
		const dispatchReceiveProgress = (progress, peerId, metadata) => {
			const requestMetadata = state.kind === "request" ? getRequestMetadata(metadata) : null;
			state.onReceiveProgress?.(progress, withMetadata({ peerId }, requestMetadata ? requestMetadata.m : metadata));
		};
		rawAction.onProgress(dispatchReceiveProgress);
		if (kind === "message") {
			let onMessage = config?.onMessage ?? null;
			const flushMessages = () => {
				if (!onMessage) return;
				const handler = onMessage;
				state.pendingMessages.splice(0).forEach(({ payload, peerId, metadata }) => {
					Promise.resolve().then(() => handler(payload, withMetadata({ peerId }, metadata))).catch((err) => console.error(`${libName} action handler error:`, err));
				});
			};
			const action = {
				send: async (data, options = {}) => {
					await rawAction.send(data, options.target, options.metadata, toProgressHandler(options.onProgress, options.metadata), options.signal);
				},
				get onMessage() {
					return onMessage;
				},
				set onMessage(handler) {
					onMessage = handler;
					flushMessages();
				},
				get onReceiveProgress() {
					return state.onReceiveProgress;
				},
				set onReceiveProgress(handler) {
					setReceiveProgress(handler);
				}
			};
			rawAction.onMessage((payload, peerId, metadata) => {
				if (!onMessage) {
					state.pendingMessages.push(metadata === void 0 ? {
						payload,
						peerId
					} : {
						payload,
						peerId,
						metadata
					});
					return;
				}
				const handler = onMessage;
				Promise.resolve().then(() => handler(payload, withMetadata({ peerId }, metadata))).catch((err) => console.error(`${libName} action handler error:`, err));
			});
			state.action = action;
			publicActions[type] = state;
			flushMessages();
			return action;
		}
		let onRequest = config?.onRequest ?? null;
		const removePendingIncomingRequest = (request) => {
			resetTimer(request.timer);
			const i = state.pendingRequests.indexOf(request);
			if (i > -1) state.pendingRequests.splice(i, 1);
		};
		const sendRequestError = (peerId, requestId, error) => {
			responseAction.send(null, peerId, {
				r: requestId,
				e: toErrorMessage(error, "request failed")
			});
		};
		const respondToIncomingRequest = (request, handler) => {
			removePendingIncomingRequest(request);
			Promise.resolve().then(() => handler(request.payload, {
				peerId: request.peerId,
				...request.metadata === void 0 ? {} : { metadata: request.metadata },
				signal: request.controller.signal
			})).then(async (response) => {
				if (response === void 0) throw mkErr("request handler returned undefined");
				await responseAction.send(response, request.peerId, { r: request.requestId });
			}).catch((err) => sendRequestError(request.peerId, request.requestId, err)).finally(() => request.controller.abort());
		};
		const flushRequests = () => {
			if (!onRequest) return;
			state.pendingRequests.slice().forEach((request) => respondToIncomingRequest(request, onRequest));
		};
		const queueIncomingRequest = (payload, peerId, metadata, requestId) => {
			if (onRequest) {
				const request = {
					payload,
					peerId,
					...metadata === void 0 ? {} : { metadata },
					requestId,
					controller: new AbortController(),
					timer: null
				};
				respondToIncomingRequest(request, onRequest);
				return;
			}
			const request = {
				payload,
				peerId,
				...metadata === void 0 ? {} : { metadata },
				requestId,
				controller: new AbortController(),
				timer: setTimeout(() => {
					removePendingIncomingRequest(request);
					request.controller.abort();
					sendRequestError(peerId, requestId, "request handler unavailable");
				}, requestHandlerBufferMs)
			};
			state.pendingRequests.push(request);
		};
		const requestOne = async (data, options) => {
			const { target, metadata, onProgress, signal, timeoutMs } = options;
			throwIfAborted(signal);
			if (!getPeer(target, false)) throw makeActionError("disconnected", `no active peer with id ${target}`);
			const requestId = genId(20);
			const handledResponsePromise = new Promise((resolve, reject) => {
				const waiter = {
					peerId: target,
					resolve,
					reject,
					timer: null,
					...signal === void 0 ? {} : { signal }
				};
				const rejectAsAborted = () => {
					clearPendingRequestWaiter(requestId);
					reject(makeActionError("aborted", "operation aborted"));
				};
				if (signal) {
					waiter.abortHandler = rejectAsAborted;
					signal.addEventListener("abort", rejectAsAborted, { once: true });
				}
				pendingRequestWaiters[requestId] = waiter;
			}).catch((err) => {
				throw err;
			});
			try {
				await rawAction.send(data, target, metadata === void 0 ? { r: requestId } : {
					r: requestId,
					m: metadata
				}, toProgressHandler(onProgress, metadata), signal);
				const waiter = pendingRequestWaiters[requestId];
				if (waiter && timeoutMs !== void 0) waiter.timer = setTimeout(() => {
					clearPendingRequestWaiter(requestId);
					waiter.reject(makeActionError("timeout", "request timed out"));
				}, timeoutMs);
				return await handledResponsePromise;
			} catch (err) {
				clearPendingRequestWaiter(requestId);
				throw err;
			}
		};
		const action = {
			request: requestOne,
			requestMany: async (data, options) => {
				throwIfAborted(options.signal);
				return await all(options.targets.map(async (target) => {
					try {
						const result = {
							peerId: target,
							status: "fulfilled",
							value: await requestOne(data, {
								target,
								...options.metadata === void 0 ? {} : { metadata: options.metadata },
								...options.timeoutMs === void 0 ? {} : { timeoutMs: options.timeoutMs },
								...options.onProgress === void 0 ? {} : { onProgress: options.onProgress },
								...options.signal === void 0 ? {} : { signal: options.signal }
							})
						};
						options.onResult?.(result);
						return result;
					} catch (err) {
						const error = toError(err, "request failed");
						if (error.kind === "aborted" || !error.kind) throw error;
						const result = error.kind === "timeout" ? {
							peerId: target,
							status: "timeout"
						} : error.kind === "disconnected" ? {
							peerId: target,
							status: "disconnected"
						} : {
							peerId: target,
							status: "rejected",
							error
						};
						options.onResult?.(result);
						return result;
					}
				}));
			},
			get onRequest() {
				return onRequest;
			},
			set onRequest(handler) {
				onRequest = handler;
				flushRequests();
			},
			get onReceiveProgress() {
				return state.onReceiveProgress;
			},
			set onReceiveProgress(handler) {
				setReceiveProgress(handler);
			}
		};
		rawAction.onMessage((payload, peerId, metadata) => {
			const requestMetadata = getRequestMetadata(metadata);
			if (!requestMetadata) return;
			queueIncomingRequest(payload, peerId, requestMetadata.m, requestMetadata.r);
		});
		state.action = action;
		publicActions[type] = state;
		flushRequests();
		return action;
	};
	return {
		makeAction: makeActionImpl,
		makeInternalAction,
		handleData,
		clearPeer
	};
};
//#endregion
export { createActionManager };

