---
"@dashcommerce/paystack": patch
---

Cart coupons work with Paystack. A cart with a coupon used to get a 409 at checkout ("does not support: coupons"). Core already sends Paystack the total after the discount, so the package now declares `coupons`.
