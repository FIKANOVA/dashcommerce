---
"@dashcommerce/core": patch
---

Keep the cart's region on an order paid through hosted Stripe Checkout. The order's ship-to region used to be whatever Stripe's free-text state field said ("Nairobi"), not the region code the cart priced shipping on (`30`). `checkout.session.completed` now keeps the cart's region when it has one in the same country, and otherwise stores a state name the shop knows as its ISO 3166-2 code. Billing addresses get the same name-to-code mapping; a state the shop has no name for is kept as Stripe sent it.
