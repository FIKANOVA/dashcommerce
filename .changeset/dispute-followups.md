---
"@dashcommerce/core": patch
---

Dispute follow-ups. A dispute on a provider subscription renewal is no longer dropped as an orphan: it is recorded on the renewal's subscription invoice and the admins are emailed with the payment reference and customer, without counting it against any order. Admins are emailed the first time core sees a dispute whatever its status, with wording that fits an open, won or lost dispute. A lost dispute that later turns won stops counting as a refund (its refund row is marked failed and the order's totals are recomputed). Disputes keep the provider's label, so the admin card says "Paystack", not `paystack`. A lost dispute on a payment split with vendors is logged and flagged on the admin order page; vendor shares are not clawed back automatically.
