/**
 * Idempotent order fulfilment boundary.
 *
 * Sequence:
 *   1. Check if an OrderFulfilment exists with this idempotencyKey.
 *      If so, enforce same-key/same-payload replay idempotency.
 *   2. Validate order status and existence.
 *   3. Record fulfilment record in storage (`order_fulfilments`).
 *   4. Update order status if applicable.
 */

import type { PluginContext, StorageCollection } from "emdash";
import type { Order, OrderFulfilment } from "../types";
import { randomId } from "../util/ids";
import { loadOrder } from "./create";

type OrderFulfilmentsStore = StorageCollection<OrderFulfilment>;
function fulfilmentsStore(ctx: PluginContext): OrderFulfilmentsStore {
	return (ctx.storage as unknown as { order_fulfilments: OrderFulfilmentsStore }).order_fulfilments;
}

type OrdersStore = StorageCollection<Order>;
function ordersStore(ctx: PluginContext): OrdersStore {
	return (ctx.storage as unknown as { orders: OrdersStore }).orders;
}

export interface FulfillOrderInput {
	orderId: string;
	idempotencyKey: string;
	items: Array<{ orderItemId: string; quantity: number }>;
	trackingNumber?: string;
	carrier?: string;
	metadata?: Record<string, unknown>;
}

export async function fulfillOrder(
	ctx: PluginContext,
	input: FulfillOrderInput,
): Promise<OrderFulfilment> {
	if (!input.idempotencyKey || input.idempotencyKey.trim() === "") {
		throw new Error("Fulfilment requires a non-empty idempotencyKey");
	}

	const store = fulfilmentsStore(ctx);
	const existingResult = await store.query({
		where: { idempotencyKey: input.idempotencyKey },
		limit: 1,
	});

	const prior = existingResult.items[0]?.data as OrderFulfilment | undefined;
	if (prior) {
		if (prior.orderId === input.orderId) {
			return prior; // Same-key replay: return existing result
		}
		throw new Error(
			`Conflict: fulfilment with idempotencyKey "${input.idempotencyKey}" already processed for order ${prior.orderId}, requested ${input.orderId}`,
		);
	}

	const order = await loadOrder(ctx, input.orderId);
	if (!order) {
		throw new Error(`Order ${input.orderId} not found`);
	}

	if (order.status === "cancelled" || order.status === "refunded") {
		throw new Error(`Cannot fulfill order in terminal status "${order.status}"`);
	}

	const fulfilment: OrderFulfilment = {
		id: randomId(),
		orderId: input.orderId,
		idempotencyKey: input.idempotencyKey,
		status: "fulfilled",
		trackingNumber: input.trackingNumber,
		carrier: input.carrier,
		items: input.items,
		metadata: input.metadata,
		createdAt: new Date().toISOString(),
	};

	await store.put(fulfilment.id, fulfilment);

	// Advance processing orders to completed
	if (order.status === "processing" || order.status === "pending") {
		await ordersStore(ctx).put(order.id, {
			...order,
			status: "completed",
			completedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
	}

	return fulfilment;
}
