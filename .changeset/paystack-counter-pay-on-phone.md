---
"@dashcommerce/paystack": minor
---

Counter sales: "Pay on their phone" through `POST /transaction/initialize` for the exact sale total (reference `dc-<draft>`, the draft's metadata, the vendor split), in KES, NGN, GHS, ZAR or USD, returning Paystack's checkout page for the counter's QR code and share links. A sale with a vendor's product is offered by link only (`/charge` takes no inline split), and `getPaymentStatus` now reports the split Paystack settled, so a counter order created by the status check records the vendor's share too. The provider says which counter methods split (link) and which currencies the prompt (KES) and terminals (NGN, GHS, ZAR, USD) take, so the counter offers only those.
