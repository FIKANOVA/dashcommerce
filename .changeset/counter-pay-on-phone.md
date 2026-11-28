---
"@dashcommerce/core": minor
---

Counter sales: "Pay on their phone", vendor products, and safeguards. A third counter method shows the payment provider's own page for the sale as a QR code, drawn by the admin page itself with no outside service, with Share on WhatsApp, Send by SMS and Copy link, and emails it to the customer when staff enter their email. Status, order creation, time-out and late payment work as for the other methods. The provider seam gains the `"link"` method (`startInPersonPayment` returns `paymentUrl`), `inPersonSplitMethods` and `inPersonCurrencies`, and `startInPersonPayment` now gets the draft metadata, a return URL and, for a sale with vendor products, the same vendor split as online checkout.

Counter sales are now off until an admin turns them on in Settings: while off, the counter routes answer 404. Counter sale leaves the sidebar (EmDash can't hide an entry at runtime); Orders and Settings link to it once it is on. **If you already sell at the counter, turn it on in Settings after upgrading.** The counter screen says a sale is paid only when it says Paid, and closes after 15 minutes without use (set in Settings).
