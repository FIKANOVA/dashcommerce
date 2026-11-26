/**
 * The shopper's currency, for server-rendered pages.
 *
 * Cart responses set the `dashcommerce_currency` cookie to the cart's
 * currency. Pages read it here and pass it to `ProductDetails`,
 * `ProductCard` and `ProductGrid` (their `currency` prop), so a shopper who
 * switched to KES sees KES prices, matching the cart. Returns `undefined`
 * before the first cart response; the components then fall back to the
 * product's first price, as before.
 *
 * Pages vary by this cookie, so a page cache must too.
 */

export const STOREFRONT_CURRENCY_COOKIE = "dashcommerce_currency";

/** Accepts Astro's `Astro.cookies`, or anything with the same `get`. */
export function storefrontCurrency(cookies: {
	get(name: string): { value: string } | undefined;
}): string | undefined {
	const raw = cookies.get(STOREFRONT_CURRENCY_COOKIE)?.value;
	if (!raw) return undefined;
	const code = decodeURIComponent(raw).trim().toUpperCase();
	return /^[A-Z]{3}$/.test(code) ? code : undefined;
}
