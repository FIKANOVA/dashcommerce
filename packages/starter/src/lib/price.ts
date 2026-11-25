/**
 * Product prices for the storefront pages, in the shopper's currency.
 *
 * `currency` comes from `storefrontCurrency(Astro.cookies)`, the cart's
 * currency. Before the shopper has a cart it is undefined, and the price
 * falls back to the product's first listed currency, as core's components do.
 * Returns null when the product has no price in that currency.
 */

export type PriceMap = Record<string, { amount: number; compareAtAmount?: number }>;

export function formatPrice(prices: PriceMap | undefined, currency?: string): string | null {
	if (!prices) return null;
	const code = currency ?? Object.keys(prices)[0];
	const price = code ? prices[code] : undefined;
	if (!code || !price) return null;
	return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(
		price.amount / 100,
	);
}
