---
"@dashcommerce/core": patch
---

Stop a shopper paying twice on hosted Stripe Checkout. When a new attempt replaces an earlier one (the shopper went back from Stripe's page and pressed Pay again), `checkout/create-session` now expires the earlier Checkout Session, the way `checkout/create-intent` cancels an earlier PaymentIntent. The session id is recorded on the shopper's hold. If Stripe won't expire it because it is already complete (paid, or an async payment still settling), the new attempt is refused with the same 409 `earlier_payment_processing`. Before this, only the on-hold duplicate order caught a second payment.
