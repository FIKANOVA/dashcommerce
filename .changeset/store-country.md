---
"@dashcommerce/core": minor
"@dashcommerce/starter": patch
---

Start checkout on the shop's own country. Checkout's country field always started on `US`. A new optional `storeCountry` setting (Settings → Store → Shop country, an ISO 3166-1 alpha-2 code) says where the shop is based, and `HostedCheckoutForm` takes a matching `defaultCountry` prop for the ship-to country and a digital order's country. The starter passes the setting to the hosted form and to its embedded Stripe form. Customers can still change the country. Without the setting nothing changes: the ship-to country starts on `US` and a digital order's country starts empty.
