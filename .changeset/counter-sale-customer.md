---
"@dashcommerce/core": patch
---

Stop counting counter sales against the seller. A counter sale without a customer email used the seller's email for the order, so the sale landed on the seller's customer record and the receipt went to the seller. Now the order goes to a shared walk-in customer (`walk-in@counter.invalid`, never emailed, keeping no phone number) and no receipt is sent; with a customer email, the order, customer record and receipt use it as before. The seller's email is still what the payment provider gets when the customer gives none, since the provider needs one, and a webhook carrying it no longer replaces the counter sale's customer. `admin/counter/sale` takes an optional `customerPhone` (checked like the phone-prompt number), and the Counter sale page asks for it on terminal sales and says what happens without an email.
