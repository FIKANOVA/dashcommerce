---
"@dashcommerce/core": patch
---

Apply the tax table. With the tax mode set to "Rate table", carts and checkout charged no tax: `recalculate()` only uses table rates through a `taxResolver`, and the cart and checkout routes never supplied one, so the rates on the Tax page were never read. Both routes now load the shop's `tax_rates` and match them against the order's address (the shipping address, or billing for digital carts) under the `standard` tax class, so tax lines appear on the cart and are included in the amount the payment provider charges.

Matching follows the rate's fields: country always, region only when the rate names one, and a postcode prefix only when the address has a postcode. Regions compare without case or surrounding spaces, postcodes without case or spaces. Before, a postcode-prefix rate also applied to addresses with no postcode. Until the customer gives an address, no table tax is added. Flat and Stripe Tax amounts are unchanged.

The cart page, the checkout summary and the order receipt now show one row per tax line, named by the rate ("VAT 16%"), instead of a single "Tax" row, so a rate's name reaches the customer. The flat rate's line is now called "Tax" (it was "Sales tax"), so a flat-rate shop shows "Tax 16%", and Stripe's hosted page names the line "Tax". A total with no tax lines still shows as "Tax".
