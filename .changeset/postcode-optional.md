---
"@dashcommerce/core": patch
"@dashcommerce/starter": patch
---

Make the postcode optional at checkout. Shipping zones match on country and region only, and many addresses have no postcode, but `cart/shipping-location` answered 400 without one and `checkout/create-session` refused a ship-to address without one. Both now need only the country; a postcode that is given is still stored, for tax rates that match on postcode prefixes. The postcode field in `HostedCheckoutForm` and the starter's embedded checkout form is marked optional.
