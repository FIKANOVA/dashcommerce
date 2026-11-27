---
"@dashcommerce/core": patch
---

Put stock back when an order is cancelled or refunded with "Restock items". A paid order takes stock, including an on-hold one (a duplicate payment for one checkout, or an amount mismatch), but cancelling it gave nothing back, and the admin's "Restock items" toggle did nothing because the refund carried no item lines. Cancelling now puts back what the order still holds, and "Restock items" on a refund of the whole remaining balance restocks every item; both read the inventory ledger, so nothing is put back twice. A partial refund with `restock` but no `lineItemRefunds` is now refused with 400 instead of quietly not restocking, and the admin shows the toggle only for a full refund.

Every restock is also clamped to the stock the order still holds, by product and variant, including lines the caller names: refunding a cancelled order with "Restock items", two partial refunds of the same unit, or asking back more units than the line took no longer puts stock back twice. Each refund line records the units actually put back as `restockedQuantity`, which a later failed refund takes back.
