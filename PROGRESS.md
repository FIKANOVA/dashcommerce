# Progress: provider-neutral payment setup and on-page checkout (FIK-59)
Last session: 2026-11-19 (final)

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
- Slice 1, provider contract — `80e685e`.
- Slice 2, setup state and admin API — `8c83c2e`.
- Slice 3, neutral storefront (config-check, hosted form copy and details, starter gate) — `f355ada`.
- Slice 4, on-page checkout in core (create-session `on_page`, 409 when undeclared, form opens the provider's browser client) — `55c3c31`.

## Scope cut by the founder (19 Nov 2026), this branch is superseded
- **Kept as the provider picker:** FIK-58's Settings picker, now shown as provider **cards** with nothing selected on a new store. That's `19fc5c9` on `feat/FIK-58-core-provider-enablement` (fork PR #3).
- **Required, kept:** checkout follows the active provider, plus collecting customer details. Branch `feat/FIK-59-checkout-follows-provider` (fork PR #4).
- **Built, optional upstream later:** on-page checkout for any provider. Branch `feat/FIK-59-on-page-checkout` (fork PR #5). Paystack's Popup client is on FIK-57 (fork PR #2).
- **Parked, not for upstream:** design A, the setup-status routes and the Payments dashboard widget, on `wip/FIK-59-design-a`. The setup routes and `checkConnection` are dropped from the plan.
- **Combined test branch:** `test/FIK-57-paystack-e2e`. The manual script is `docs/testing/paystack-e2e.md` there.

## In progress
- None. Everything is built; waiting on the founder's manual end-to-end run.

## Deviations (Field Guide rule)
- Spec scope 1 said a separate "Set up payments" admin page with banners → founder (19 Nov) asked for it as a **Settings configuration**: providers side by side (or listed) with logos, Stripe or nothing selected by default. Slice 5 builds the payments section inside Settings; the `admin/setup/*` routes from slice 2 feed it unchanged. Logos: providers declare their own official logo; core ships no third-party logo, and falls back to a lettered tile.
- Spec scope 4/5 said "provider-neutral copy and gate" → also added `collectsCustomerDetails` to the provider contract, a 409 `customer_details_required` in `create-session`, and a "Your details" fieldset in `HostedCheckoutForm` — because Stripe's hosted page collects email and address and core relies on that, while Paystack's does not: without this a Paystack checkout fails at Pay (no email) and the paid order is never created (webhook: "Session missing address"). Conservative choice: reuse `cart/contact`; Stripe (collects them) is unchanged.

## Blocked
- (none)

## Proposed additions (not in spec — needs approval)
- Admin dark theme: select and input text in plugin cards is low-contrast (existing EmDash or kit issue).
- `create-session` turns any provider error into a generic 500. The form now shows a readable fallback, but the route could return the provider's message.
