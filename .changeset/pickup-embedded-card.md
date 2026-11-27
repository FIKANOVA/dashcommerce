---
"@dashcommerce/core": patch
---

Let a local pickup cart pay with the embedded Stripe card form without a delivery address. `checkout/create-intent` asked for both a billing and a shipping address even when the chosen method was local pickup, which hosted checkout no longer does. A pickup cart now needs only one address (the ship-to country chosen for the rates is enough), and the order uses it for both, as hosted checkout's orders do. Delivery carts still need both addresses.
