# Progress: provider-neutral payment setup and on-page checkout (FIK-59)
Last session: 2026-11-19

Fork-only file: drop before any upstream PR.

## Plan (slices, each committed end to end)
1. Provider contract: `description`, `checkoutStyles`, `checkConnection`, the `on_page` init result; Stripe and mock declarations.
2. Setup state and admin API: `setup:keysSavedAt:<id>` on credential save; `admin/setup/status`, `admin/setup/check`.
3. Neutral storefront: `config-check.paymentProvider`, hosted form copy from the provider label, starter checkout gate on the active provider.
4. On-page checkout in core: `create-session` returns `on_page` (or a 409 if not declared); the storefront component opens the provider's client.
5. Admin: Set up payments screen, banners on Settings and Dashboard, generic Test connection in Settings.
6. Paystack: `checkoutStyles`, `on_page` init, `checkConnection`, the `checkout-client` entry (lazy `inline.js`).
7. Starter test branch: both providers, four-way manual script.

## Done
- Spec approved (19 Nov 2026).

## In progress
- Slice 1.

## Deviations (Field Guide rule)
- (none yet)

## Blocked
- (none)

## Proposed additions (not in spec — needs approval)
- (none yet)
