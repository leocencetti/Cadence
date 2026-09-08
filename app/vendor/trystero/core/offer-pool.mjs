import { all, alloc, noOp, resetTimer } from "./utils.mjs";
//#region src/offer-pool.ts
const offerTtl = 57333;
const offerLeaseTtlMs = 18e4;
const poolSize = 20;
var OfferPool = class {
	makeOffer;
	pool = [];
	pooled = /* @__PURE__ */ new Set();
	leased = /* @__PURE__ */ new Map();
	recycling = /* @__PURE__ */ new Set();
	cleanupTimer = null;
	active = false;
	constructor(makeOffer) {
		this.makeOffer = makeOffer;
	}
	get isActive() {
		return this.active;
	}
	warmup() {
		this.pool = [];
		this.pooled.clear();
		alloc(poolSize, this.makeOffer).forEach((p) => this.push(p));
		this.active = true;
		this.cleanupTimer = setInterval(() => {
			this.pool = this.pool.filter((peer) => {
				if (peer.isDead) {
					this.pooled.delete(peer);
					return false;
				}
				return true;
			});
		}, offerTtl);
	}
	push(peer) {
		if (peer.isDead || this.pooled.has(peer) || this.leased.has(peer)) return;
		this.pool.push(peer);
		this.pooled.add(peer);
	}
	shift(n) {
		const peers = [];
		while (peers.length < n && this.pool.length > 0) {
			const peer = this.pool.shift();
			if (!peer) break;
			this.pooled.delete(peer);
			peers.push(peer);
		}
		return peers;
	}
	claimLeased(peer) {
		const timer = this.leased.get(peer);
		if (timer) {
			resetTimer(timer);
			this.leased.delete(peer);
		}
	}
	recycle(peer) {
		if (peer.isDead || this.recycling.has(peer)) return;
		if (peer.connection.remoteDescription) {
			peer.destroy();
			return;
		}
		if (!this.active) {
			peer.destroy();
			return;
		}
		this.recycling.add(peer);
		peer.setHandlers({
			connect: noOp,
			close: noOp,
			error: noOp
		});
		peer.getOffer(true).then((offer) => {
			if (!offer || offer.type !== "offer" || peer.isDead || !this.active) {
				peer.destroy();
				return;
			}
			this.push(peer);
		}).catch(() => peer.destroy()).finally(() => this.recycling.delete(peer));
	}
	reclaimLeased(peer) {
		const timer = this.leased.get(peer);
		if (!timer) return;
		resetTimer(timer);
		this.leased.delete(peer);
		this.recycle(peer);
	}
	lease(peer) {
		this.claimLeased(peer);
		this.leased.set(peer, setTimeout(() => {
			this.leased.delete(peer);
			this.recycle(peer);
		}, offerLeaseTtlMs));
	}
	checkout(n, leaseOffers, encryptOffer) {
		const peers = this.shift(n);
		const missing = Math.max(0, n - peers.length);
		if (missing > 0) peers.push(...alloc(missing, this.makeOffer));
		const toRecord = async (candidate, didRetry = false) => {
			try {
				const offer = await encryptOffer(candidate);
				if (leaseOffers) {
					this.lease(candidate);
					return {
						peer: candidate,
						offer,
						claim: () => this.claimLeased(candidate),
						reclaim: () => this.reclaimLeased(candidate)
					};
				}
				return {
					peer: candidate,
					offer
				};
			} catch (err) {
				this.claimLeased(candidate);
				this.pooled.delete(candidate);
				candidate.destroy();
				if (!didRetry) return toRecord(this.makeOffer(), true);
				throw err;
			}
		};
		return all(peers.map((peer) => toRecord(peer)));
	}
	getOffers(n, encryptOffer) {
		return this.checkout(n, true, encryptOffer);
	}
	destroy() {
		this.active = false;
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
		this.pool.forEach((peer) => peer.destroy());
		this.pool = [];
		this.pooled.clear();
		this.leased.forEach((timeout, peer) => {
			resetTimer(timeout);
			peer.destroy();
		});
		this.leased.clear();
		this.recycling.forEach((peer) => peer.destroy());
		this.recycling.clear();
	}
};
//#endregion
export { OfferPool, offerTtl };

