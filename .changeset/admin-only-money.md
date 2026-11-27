---
"@dashcommerce/core": patch
---

Keep money for EmDash Admins. The refund route, payment-setting changes (provider choice, checkout mode, Stripe keys, provider keys and webhook secrets), the payment connection checks, subscription cancel and resume, and vendor payout changes (creating or editing a vendor, onboarding links, payout accounts) now check `ctx.user.role` and answer 403 with a plain message for anyone else, including calls with no signed-in user. EmDash's default `plugins:manage` permission already limits DashCommerce's admin routes to Admins; this keeps money admin-only if other routes are opened to Editors. The admin hides the refund form and greys out the payment cards for non-admins.
