/**
 * Device Stock Allocation for offline POS boundaries.
 *
 * Server-provisioned per-device stock allocations bound offline sales.
 * Deducts allocated stock from online availability at allocation time.
 * Unused allocation requires explicit reconciliation, not automatic resale.
 */

import type { PluginContext, StorageCollection } from "emdash";
import { OversoldError } from "../inventory/decrement";
import { normalizeProductFields } from "../products/normalize";
import { adjustVariantStock } from "../products/variants";
import type { DeviceStockAllocation } from "../types";
import { randomId } from "../util/ids";

type AllocationStore = StorageCollection<DeviceStockAllocation>;
function allocationStore(ctx: PluginContext): AllocationStore {
	return (ctx.storage as unknown as { device_stock_allocations: AllocationStore })
		.device_stock_allocations;
}

export interface AllocateStockInput {
	deviceId: string;
	merchantId?: string;
	productId: string;
	variantId?: string;
	quantity: number;
	ttlMs?: number; // default 24h
}

export interface ReconcileAllocationInput {
	allocationId: string;
	soldQuantity: number;
	operatorId?: string;
}

export async function allocateStock(
	ctx: PluginContext,
	input: AllocateStockInput,
): Promise<DeviceStockAllocation> {
	if (input.quantity <= 0) {
		throw new Error("Allocation quantity must be greater than 0");
	}

	const now = new Date();
	const ttlMs = input.ttlMs ?? 24 * 60 * 60 * 1000;
	const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

	if (input.variantId) {
		const newStock = await adjustVariantStock(ctx, input.variantId, -input.quantity);
		if (newStock !== null && newStock < 0) {
			// rollback
			await adjustVariantStock(ctx, input.variantId, input.quantity);
			throw new OversoldError(
				input.productId,
				input.variantId,
				input.quantity,
				newStock + input.quantity,
			);
		}
	} else if (ctx.content) {
		const record = await ctx.content.get("products", input.productId);
		if (!record) {
			throw new Error(`Product ${input.productId} not found`);
		}
		const fields = normalizeProductFields(record.data as Record<string, unknown>);
		if (fields.manageStock) {
			const current = fields.stockQuantity ?? 0;
			if (current < input.quantity) {
				throw new OversoldError(input.productId, undefined, input.quantity, current);
			}
			const newStock = current - input.quantity;
			if (ctx.content.update) {
				await ctx.content.update("products", input.productId, {
					stock_quantity: newStock,
					stock_status: newStock <= 0 ? "outofstock" : fields.stockStatus,
				});
			}
		}
	}

	const allocation: DeviceStockAllocation = {
		id: randomId(),
		deviceId: input.deviceId,
		...(input.merchantId ? { merchantId: input.merchantId } : {}),
		productId: input.productId,
		...(input.variantId ? { variantId: input.variantId } : {}),
		allocatedQuantity: input.quantity,
		soldQuantity: 0,
		status: "active",
		expiresAt,
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
	};

	await allocationStore(ctx).put(allocation.id, allocation);
	return allocation;
}

export async function reconcileAllocation(
	ctx: PluginContext,
	input: ReconcileAllocationInput,
): Promise<DeviceStockAllocation> {
	const store = allocationStore(ctx);
	const existing = await store.get(input.allocationId);
	if (!existing) {
		throw new Error(`Device allocation ${input.allocationId} not found`);
	}

	if (existing.status !== "active") {
		throw new Error(`Allocation ${input.allocationId} is already ${existing.status}`);
	}

	if (input.soldQuantity > existing.allocatedQuantity) {
		throw new Error(
			`Sold quantity (${input.soldQuantity}) cannot exceed allocated quantity (${existing.allocatedQuantity})`,
		);
	}

	const unsold = existing.allocatedQuantity - input.soldQuantity;

	// Return unsold stock back to online inventory
	if (unsold > 0) {
		if (existing.variantId) {
			await adjustVariantStock(ctx, existing.variantId, unsold);
		} else if (ctx.content) {
			const record = await ctx.content.get("products", existing.productId);
			if (record) {
				const fields = normalizeProductFields(record.data as Record<string, unknown>);
				if (fields.manageStock) {
					const current = fields.stockQuantity ?? 0;
					const newStock = current + unsold;
					if (ctx.content.update) {
						await ctx.content.update("products", existing.productId, {
							stock_quantity: newStock,
							stock_status: "instock",
						});
					}
				}
			}
		}
	}

	const updated: DeviceStockAllocation = {
		...existing,
		soldQuantity: input.soldQuantity,
		status: "reconciled",
		updatedAt: new Date().toISOString(),
	};

	await store.put(updated.id, updated);
	return updated;
}
