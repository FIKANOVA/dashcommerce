---
"@dashcommerce/core": minor
"@dashcommerce/paystack": minor
---

Counter sales (in-person checkout). A new "Counter sale" admin page lets staff sell from the shop's own products and stock: they add products, choose how the customer pays (an M-PESA prompt on the customer's phone, or a card terminal when the provider lists one), and the page checks every few seconds until the payment is confirmed, declined or timed out. Stock is held while the customer pays and released if the payment fails or times out. The order goes through the same path as an online order (stock, coupons, receipt email) and is marked `channel: "in_person"` with the seller's EmDash user id in `soldBy`; the Orders list can filter by channel.

New admin routes: `admin/counter/setup`, `admin/counter/products`, `admin/counter/sale` and `admin/counter/status?draft=`. They allow EmDash Editors and Admins (role 40 and up) and refuse anyone else or a call with no user; refunds stay admin-only.

New optional `PaymentProvider` members: `inPersonMethods`, `listTerminals` and `startInPersonPayment`; status still comes from `getPaymentStatus`. The Paystack provider implements them: phone sales use `POST /charge` with `mobile_money` (M-PESA, KES), and terminal sales create a payment request and push it to the chosen terminal (NGN, GHS, ZAR and USD, as Paystack's payment requests allow), confirmed through `/paymentrequest/verify`. Refund a terminal sale in the Paystack dashboard.
