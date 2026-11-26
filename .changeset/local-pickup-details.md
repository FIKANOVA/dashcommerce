---
"@dashcommerce/core": minor
---

Local pickup methods can now carry a pickup location, opening hours and directions, set on the admin Shipping page. Checkout shows them when the shopper picks pickup and stops asking for a delivery address (email and name are still collected when the payment provider needs them, and Stripe's page is no longer asked to collect a shipping address). The order, thank-you page and receipt email say "Pickup" with the location. The text is stored as plain text with length limits; existing pickup methods keep working unchanged. For providers whose page doesn't collect details, a delivery order now needs a street and town before payment, not just the country.
