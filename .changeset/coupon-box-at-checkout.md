---
"@dashcommerce/core": patch
---

Add the coupon box to the checkout order summary. Until now a code could only be entered on `/cart`, so a shopper who went from the cart drawer straight to checkout never saw one. The cart page and `CheckoutSidebarIsland` now share one `CouponBox` island, which uses the existing `cart/coupon` and `cart/coupon/remove` routes; applying or removing a code refreshes the summary totals. The cart drawer is unchanged.
