---
"@dashcommerce/core": patch
"@dashcommerce/starter": patch
---

Show the shipping options once on hosted checkout. The order summary listed them as radio buttons while `HostedCheckoutForm` also asked for a choice in its shipping step. `CheckoutSidebar` and `CheckoutSidebarIsland` take a new `shippingPicker` prop (default `true`, so existing pages are unchanged). With `shippingPicker={false}`, the summary doesn't list or fetch the options and shows the chosen one in its totals, for example "Shipping · Standard delivery", with "Free" for a zero-priced option. The starter turns the picker off for the hosted form and keeps it for the embedded Stripe form, which has no shipping step of its own.
