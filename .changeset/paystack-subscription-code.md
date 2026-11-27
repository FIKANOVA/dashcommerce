---
"@dashcommerce/core": patch
"@dashcommerce/paystack": patch
---

A failed Paystack renewal now marks the subscription past due. Paystack's `invoice.payment_failed` names the subscription (`SUB_…` code) but not the plan, which is the id core stores, so the event was left unhandled. `subscription.updated` events gain an optional `providerSubscriptionRef` (and `providerSubscriptionId` becomes optional): core remembers the ref whenever an event carries both, and matches later events by it. Paystack's subscription event ids now include a fingerprint of the payload, so cancelling again after a resume is no longer skipped as a duplicate.
