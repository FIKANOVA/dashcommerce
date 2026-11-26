---
"@dashcommerce/core": patch
"@dashcommerce/starter": patch
---

Stripe Elements now fixes the amount when the customer presses Pay, like Stripe Checkout and the other payment providers. Before, `CheckoutFormIsland` created the PaymentIntent at "Continue to payment" and kept it, so a coupon or shipping change made at checkout afterwards showed in the order summary but wasn't charged.

The card form now starts in Stripe's deferred-intent mode (`mode: "payment"` with the cart's amount and currency) and follows the cart as it changes. On Pay it validates the form, then calls `checkout/create-intent` with the total the customer saw (`expectedTotal`). The server re-prices the cart and creates the PaymentIntent only if that total still stands; otherwise it answers `409 cart_totals_changed` with the new total, which the form shows before the customer presses Pay again. Every press of Pay gets a fresh PaymentIntent and stock hold. The Pay button shows the amount. `expectedTotal` is optional, so other callers of `create-intent` are unaffected.

Checkout's stock check no longer counts the shopper's own earlier hold, as its comment always said. Each shopper has one hold at a time: a new attempt (after a decline, a closed payment popup or a cart change) replaces the previous one, on Stripe Elements and hosted checkout alike, so the same units aren't reserved twice and the last unit isn't refused to the person holding it. The earlier attempt's order draft is kept, so a payment that still completes on it creates its order as before. The hold record is removed when its hold is released or expires.

The starter shows the checkout coupon box on its embedded Stripe form again.
