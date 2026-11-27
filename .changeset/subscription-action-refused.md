---
"@dashcommerce/core": patch
"@dashcommerce/paystack": patch
---

Answer a refused subscription action with a 409, not a 500. When the payment provider won't cancel or resume a subscription (for example it is already inactive there), or the provider can't do the action at all, `POST /admin/subscriptions/action` now returns 409 with the reason and `code: "subscription_action_refused"`. Providers signal it by throwing the new `SubscriptionActionRefusedError`; Paystack does so for a 4xx from `/subscription/disable` or `/enable`.
