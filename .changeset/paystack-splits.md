---
"@dashcommerce/paystack": minor
---

Multi-vendor payments with Paystack splits.

- Each vendor gets a Paystack subaccount from the Vendors page: banks and mobile money in the shop's own Paystack country (M-PESA, Airtel and Telkom in Kenya), an account-holder lookup, then the subaccount. A vendor in another country gets a clear message instead of Paystack's error. Paystack creates subaccounts unverified; they work at once and show as unverified until Paystack verifies them.
- At checkout each vendor's share goes to their subaccount as a flat split; the shop keeps the rest and pays Paystack's fee.
- `charge.success` reports each party's amount and Paystack's fee, recorded on the order.
- Refunds on a split payment go through Paystack as usual and come from the shop's balance; the order page warns that vendor shares aren't pulled back.
