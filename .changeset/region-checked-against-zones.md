---
"@dashcommerce/core": patch
---

Check the ship-to region against the regions the shipping zones name. `cart/shipping-location`, `cart/shipping-address` and `cart/contact` now take `KE-30` as `30` when the country is Kenya, and a county or state name the shop knows ("Nairobi", "Nairobi City") as its code, so the Nairobi zone's rate applies. In a country where a zone names regions, a region no zone names is kept when it is a real region (Mombasa stays `28`) and otherwise stored as no region; either way the address gets the country-wide rate, as "Elsewhere" does. Such a region is not refused, so a typed address isn't turned away for a spelling the shop doesn't know. Countries whose zones name no regions keep the region as given.

Table tax rates compare regions the same way, on both sides: a rate saved as "Nairobi", "KE-30" or "30" applies to an address whose region is stored as `30`, so turning names into codes doesn't stop a rate typed as a name from matching.
