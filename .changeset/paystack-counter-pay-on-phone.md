---
"@dashcommerce/paystack": minor
---

Counter sales: "Pay on their phone" through `POST /transaction/initialize` for the exact sale total (reference `dc-<draft>`, the draft's metadata, the vendor split), in KES, NGN, GHS, ZAR or USD, returning Paystack's checkout page for the counter's QR code and share links. An M-PESA prompt for a sale with a vendor's product saves a flat split with `POST /split` and charges with its `split_code`. The provider says which counter methods split (phone prompt and link) and which currencies the prompt (KES) and terminals (NGN, GHS, ZAR, USD) take, so the counter offers only those.
