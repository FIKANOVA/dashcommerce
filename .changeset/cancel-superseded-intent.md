---
"@dashcommerce/core": patch
---

Stop a shopper paying twice for one checkout. When a new Stripe Elements attempt replaces an earlier one, `checkout/create-intent` cancels the earlier PaymentIntent (recorded on the shopper's hold). If Stripe won't cancel it, because it already succeeded or its payment method is still processing, the new attempt is refused with 409 `earlier_payment_processing` and a message asking the shopper to wait. For every provider, attempts that replace each other are linked, and if a replaced attempt is still paid after the checkout was already paid (for example a pending M-PESA prompt approved late), its order is placed on-hold with `metadata.duplicateOfOrderId` and download grants are withheld, so the merchant can refund it. A shopper's hold is now kept for carts without stock-tracked items too.
