---
"@dashcommerce/core": patch
"@dashcommerce/starter": patch
---

Add the coupon box to the checkout order summary. Until now a code could only be entered on `/cart`, so a shopper who went from the cart drawer straight to checkout never saw one. The cart page and `CheckoutSidebarIsland` now share one `CouponBox` island, which uses the existing `cart/coupon` and `cart/coupon/remove` routes; applying or removing a code refreshes the summary totals. The cart drawer is unchanged.

`CheckoutSidebar` takes a `couponEntry` prop (default `true`). The starter turns it off when its embedded Stripe Elements form is on the page: that form sets up the payment before the customer presses Pay, so a code applied afterwards would show as a discount without being charged. Hosted and on-page checkouts through `HostedCheckoutForm` (Stripe Checkout, Paystack and other providers) fix the amount when Pay is pressed and keep the box.
