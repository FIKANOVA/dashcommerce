---
"@dashcommerce/paystack": minor
---

Subscriptions with Paystack.

- Checkout creates one Paystack plan per subscription, for the cart total, and the customer pays the first period through Paystack. Paystack charges each renewal itself.
- The first payment becomes the order and the subscription; each renewal is recorded as a paid invoice and extends the period, with no second order.
- Cancel and resume from the admin or the customer portal disable and enable the Paystack subscription. Paystack has no cancel at period end, so a cancelled subscription stays active until the period already paid for ends.
- `subscription.create`, `subscription.not_renew`, `subscription.disable` and `invoice.payment_failed` update the subscription.
- Intervals Paystack can't bill (every 2 weeks, say), free trials and more than one subscription in an order are refused at checkout with a clear message, before Paystack is called.
