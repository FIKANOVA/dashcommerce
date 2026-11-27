---
"@dashcommerce/core": patch
---

Put stock back when an order is cancelled or refunded with "Restock items". A paid order takes stock, including an on-hold one (a duplicate payment for one checkout, or an amount mismatch), but cancelling it gave nothing back, and the admin's "Restock items" toggle did nothing because the refund carried no item lines. Cancelling now puts back what the order still holds, and "Restock items" on a refund of the whole remaining balance restocks every item; both read the inventory ledger, so nothing is put back twice. A partial refund with `restock` but no `lineItemRefunds` is now refused with 400 instead of quietly not restocking, and the admin shows the toggle only for a full refund.
