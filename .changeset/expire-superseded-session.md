---
"@dashcommerce/core": patch
---

Stop a shopper paying twice on hosted Stripe Checkout. When a new attempt replaces an earlier one (the shopper went back from Stripe's page and pressed Pay again), `checkout/create-session` now expires the earlier Checkout Session, the way `checkout/create-intent` cancels an earlier PaymentIntent. The session id is recorded on the shopper's hold. If Stripe won't expire it because it is already complete (paid, or an async payment still settling), the new attempt is refused with the same 409 `earlier_payment_processing`. Before this, only the on-hold duplicate order caught a second payment.

A Checkout Session can be paid for 24 hours (Stripe's default) while the stock hold lasts 15 minutes, so the shopper's last session id is also kept in its own KV pointer (`stripe-checkout:<session>`, 24 hours, not touched by the lock sweep). A new attempt expires the session named there as well as the one on the hold, so a shopper coming back hours later can't pay both. The pointer is dropped once that attempt's order is created. Holds and session lifetimes are unchanged.
