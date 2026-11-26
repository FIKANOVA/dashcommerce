---
"@dashcommerce/paystack": patch
---

Paystack's `charge.dispute.create`, `charge.dispute.remind` and `charge.dispute.resolve` webhooks become core's `dispute.updated`, so the merchant is emailed before Paystack's 16-hour auto-accept and a merchant-accepted dispute counts like a refund. Paystack does not document the payload, so it is read defensively; an event missing the dispute id, the transaction reference, the amount or a known resolution is left unhandled.
