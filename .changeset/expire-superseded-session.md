---
"@dashcommerce/core": patch
---

Stop a shopper paying twice on hosted Stripe Checkout. When a new attempt replaces an earlier one (the shopper went back from Stripe's page and pressed Pay again), `checkout/create-session` now expires the earlier Checkout Session, the way `checkout/create-intent` cancels an earlier PaymentIntent. The session id is recorded on the shopper's hold. If Stripe won't expire it because it is already complete (paid, or an async payment still settling), the new attempt is refused with the same 409 `earlier_payment_processing`. Before this, only the on-hold duplicate order caught a second payment.

A hosted Stripe attempt is now held for 31 minutes instead of 15, and its Checkout Session is created with `expires_at` at the same moment (just over Stripe's 30-minute minimum; Stripe's default is 24 hours). So while the session can still be paid, the shopper's hold still names it and a later attempt expires it; once the hold ends, Stripe has closed the session too. Its stock stays reserved for those 31 minutes. Other providers keep the 15-minute hold. `InitCheckoutInput` takes an optional `expiresAt` (Unix seconds) that providers without such a setting ignore.
