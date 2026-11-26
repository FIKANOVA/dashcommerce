/**
 * Stock soft-locks.
 *
 * When a customer reaches checkout and we create a PaymentIntent, we also
 * reserve inventory for them for 15 minutes via KV-backed locks (keyed
 * `lock:{orderDraftId}`). A subsequent customer seeing the product page
 * should have locked quantity subtracted from the available-to-sell figure.
 *
 * Locks are released on any of:
 *   - `payment_intent.succeeded` webhook → order creation consumes them
 *   - `payment_intent.payment_failed` / `canceled` webhook
 *   - TTL expiry swept by the cron hook (`hooks/cron.ts`, every 5 min)
 */

import type { PluginContext } from "emdash";
import type { StockLock } from "../types";

const LOCK_PREFIX = "lock:";
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export function lockKey(orderDraftId: string): string {
	return `${LOCK_PREFIX}${orderDraftId}`;
}

export function newLock(
	orderDraftId: string,
	sessionId: string,
	entries: StockLock["entries"],
	opts: { ttlMs?: number; stripePaymentIntentId?: string } = {},
): StockLock {
	const now = Date.now();
	const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
	return {
		orderDraftId,
		sessionId,
		...(opts.stripePaymentIntentId ? { stripePaymentIntentId: opts.stripePaymentIntentId } : {}),
		entries,
		expiresAt: new Date(now + ttl).toISOString(),
		createdAt: new Date(now).toISOString(),
	};
}

export async function createLock(ctx: PluginContext, lock: StockLock): Promise<void> {
	await ctx.kv.set(lockKey(lock.orderDraftId), lock);
}

export async function getLock(
	ctx: PluginContext,
	orderDraftId: string,
): Promise<StockLock | null> {
	return (await ctx.kv.get<StockLock>(lockKey(orderDraftId))) ?? null;
}

export async function deleteLock(ctx: PluginContext, orderDraftId: string): Promise<void> {
	const lock = await getLock(ctx, orderDraftId);
	await ctx.kv.delete(lockKey(orderDraftId));
	if (lock) await clearHoldPointer(ctx, lock);
}

/** The shopper's current hold, so a new attempt can replace it. */
function holdKey(sessionId: string): string {
	return `hold:${sessionId}`;
}

/** Forget the shopper's hold pointer once the hold it names is gone. */
async function clearHoldPointer(ctx: PluginContext, lock: StockLock): Promise<void> {
	if ((await ctx.kv.get<string>(holdKey(lock.sessionId))) === lock.orderDraftId) {
		await ctx.kv.delete(holdKey(lock.sessionId));
	}
}

/** List all active (non-expired) locks. */
export async function listActiveLocks(ctx: PluginContext): Promise<StockLock[]> {
	const now = Date.now();
	const rows = await ctx.kv.list(LOCK_PREFIX);
	const out: StockLock[] = [];
	for (const row of rows) {
		const lock = row.value as StockLock | null;
		if (!lock) continue;
		if (Date.parse(lock.expiresAt) <= now) continue;
		out.push(lock);
	}
	return out;
}

/**
 * Sum of currently-locked units for a given product (optionally variant).
 * Used by checkout to compute available-to-sell = stock − sumActiveLocks.
 * Pass `excludeSessionId` so a shopper's own earlier hold doesn't count
 * against them when they press Pay again.
 */
export async function sumActiveLocksForProduct(
	ctx: PluginContext,
	productId: string,
	variantId?: string,
	opts: { excludeSessionId?: string } = {},
): Promise<number> {
	const locks = await listActiveLocks(ctx);
	let total = 0;
	for (const lock of locks) {
		if (opts.excludeSessionId && lock.sessionId === opts.excludeSessionId) continue;
		for (const entry of lock.entries) {
			if (entry.productId !== productId) continue;
			if (variantId !== undefined && entry.variantId !== variantId) continue;
			if (variantId === undefined && entry.variantId !== undefined) continue;
			total += entry.quantity;
		}
	}
	return total;
}

/**
 * Hold stock for a new checkout attempt. A shopper has one hold at a
 * time: their previous attempt's hold is released, so pressing Pay again
 * (after closing a payment popup, a decline, or a cart change) doesn't
 * reserve the same units twice. The earlier attempt's order draft is kept,
 * so a payment that still completes on it creates its order as before.
 *
 * Two attempts racing for one shopper (two tabs) can each read the old
 * pointer before either writes; the loser's hold then lasts until its TTL.
 * That only over-reserves briefly; stock is still decremented once, at
 * order creation.
 */
export async function holdStock(
	ctx: PluginContext,
	orderDraftId: string,
	sessionId: string,
	entries: StockLock["entries"],
	opts: { ttlMs?: number } = {},
): Promise<void> {
	const previous = await ctx.kv.get<string>(holdKey(sessionId));
	if (previous && previous !== orderDraftId) await deleteLock(ctx, previous);
	if (entries.length > 0) {
		await createLock(ctx, newLock(orderDraftId, sessionId, entries, opts));
		await ctx.kv.set(holdKey(sessionId), orderDraftId);
	} else if (previous) {
		await ctx.kv.delete(holdKey(sessionId));
	}
}

/**
 * Release a lock by orderDraftId. Safe to call for missing keys.
 * Returns `true` if a lock was found and deleted.
 */
export async function releaseLock(
	ctx: PluginContext,
	orderDraftId: string,
): Promise<boolean> {
	const existing = await getLock(ctx, orderDraftId);
	if (!existing) return false;
	await deleteLock(ctx, orderDraftId);
	return true;
}

/** Delete any lock whose `expiresAt` is in the past. Returns count swept. */
export async function sweepExpiredLocks(ctx: PluginContext): Promise<number> {
	const now = Date.now();
	const rows = await ctx.kv.list(LOCK_PREFIX);
	let swept = 0;
	for (const row of rows) {
		const lock = row.value as StockLock | null;
		if (!lock) continue;
		if (Date.parse(lock.expiresAt) > now) continue;
		await ctx.kv.delete(row.key);
		await clearHoldPointer(ctx, lock);
		swept += 1;
	}
	return swept;
}
