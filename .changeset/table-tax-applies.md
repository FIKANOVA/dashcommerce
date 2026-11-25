---
"@dashcommerce/core": patch
---

Apply the tax table. With the tax mode set to "Rate table", carts and checkout charged no tax: `recalculate()` only uses table rates through a `taxResolver`, and the cart and checkout routes never supplied one, so the rates on the Tax page were never read. Both routes now load the shop's `tax_rates` and match them against the order's address (the shipping address, or billing for digital carts) under the `standard` tax class, so tax lines appear on the cart and are included in the amount the payment provider charges.

Matching follows the rate's fields: country always, region only when the rate names one, and a postcode prefix only when the address has a postcode. Postcodes compare without case or spaces. Before, a postcode-prefix rate also applied to addresses with no postcode. Until the customer gives an address, no table tax is added. Flat and Stripe Tax modes are unchanged.
