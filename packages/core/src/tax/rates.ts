/**
 * Load the shop's tax table for table-mode pricing.
 */

import type { PluginContext } from "emdash";
import type { PricingPolicy } from "../cart/calculate";
import type { TaxRate } from "../types";
import { tableTaxResolver } from "./calculate";

/** The admin's tax table lists up to 500 rates; checkout reads the same set. */
const MAX_TAX_RATES = 500;

interface TaxRateStore {
	query(opts: {
		orderBy?: Record<string, "asc" | "desc">;
		limit: number;
	}): Promise<{ items: Array<{ id: string; data: TaxRate }> }>;
}

export async function loadTaxRates(ctx: PluginContext): Promise<TaxRate[]> {
	const store = (ctx.storage as unknown as { tax_rates: TaxRateStore }).tax_rates;
	const result = await store.query({ orderBy: { priority: "asc" }, limit: MAX_TAX_RATES });
	return result.items.map((r) => ({ ...r.data, id: r.id }));
}

/** The table-mode `taxResolver` for this shop. */
export async function loadTableTaxResolver(
	ctx: PluginContext,
): Promise<NonNullable<PricingPolicy["taxResolver"]>> {
	return tableTaxResolver(await loadTaxRates(ctx));
}
