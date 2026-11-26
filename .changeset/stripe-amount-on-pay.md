---
"@dashcommerce/core": patch
"@dashcommerce/starter": patch
---

Stripe Elements now fixes the amount when the customer presses Pay, like Stripe Checkout and the other payment providers. Before, `CheckoutFormIsland` created the PaymentIntent at "Continue to payment" and kept it, so a coupon or shipping change made at checkout afterwards showed in the order summary but wasn't charged.

The card form now starts in Stripe's deferred-intent mode (`mode: "payment"` with the cart's amount and currency) and follows the cart as it changes. On Pay it validates the form, calls `checkout/create-intent` (which re-prices the cart on the server and creates the PaymentIntent for that total) and confirms the payment. If the cart hasn't changed since the last attempt, for example after a declined card, the same PaymentIntent is reused. `create-intent` returns a new `cartUpdatedAt` field for this. The Pay button shows the amount.

Checkout's stock check no longer counts the shopper's own earlier hold, as its comment always said. A new checkout attempt replaces that shopper's previous hold, so pressing Pay again (after a decline, a closed payment popup or a cart change) can't reserve the same units twice or refuse the last unit to the person holding it. The earlier attempt's order draft is kept, so a payment that still completes on it creates its order as before.

The starter shows the checkout coupon box on its embedded Stripe form again.
