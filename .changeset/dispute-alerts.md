---
"@dashcommerce/core": minor
---

Disputes (chargebacks) from any payment provider.

- New normalised event `dispute.updated` (`providerDisputeId`, `paymentReference`, `status` of `open`, `won` or `lost`, `amount`, `currency`, optional `reason` and `dueAt`). The Stripe adapter maps `charge.dispute.created`, `charge.dispute.updated` and `charge.dispute.closed`.
- Core finds the order by payment reference (only when the same provider took the payment) and records the dispute on the order's new optional `disputes` field. Existing orders are unaffected.
- When a new dispute opens, core emails the store's admin users once, with the amount, the deadline and where to answer it (the provider's dashboard), and warns not to ship.
- A lost dispute counts like a refund: it is stored as a succeeded refund with the reason "Dispute lost", capped at what is still refundable, and the order's refunded total, payment status and order status are worked out again. The customer gets no refund email. A won dispute leaves the totals alone. A settled dispute never changes again.
- The admin order page shows a Disputes card, with "Don't ship until this is resolved" while one is open.
