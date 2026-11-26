---
"@dashcommerce/core": patch
"@dashcommerce/starter": patch
---

Storefront prices follow the cart's currency. Before, a shopper who switched to KES saw KES in the cart but USD on the home, shop, category, tag and product pages.

- Cart responses set a `dashcommerce_currency` cookie with the cart's currency.
- `storefrontCurrency(Astro.cookies)` from `@dashcommerce/core/astro` reads it; the starter's pages pass it to core's product components and their own price labels. A product with no price in that currency shows "Not available in KES" (core's existing message) or "—" on cards.
- Before a shopper's first cart response there's no cookie, and prices fall back to the product's first listed currency, as before.
- Pages that read it vary by that cookie: a site that turns on page caching must cache per currency.
