<!--
Draft for the founder to post on emdashCommerce/dashcommerce as a
discussion (preferred, "Ideas") or an issue. Not posted yet.
Everything between the two rules below is the body, ready to paste.
Facts checked against upstream on 19 November 2026 (main at 1bd6a82, v0.3.5).
-->

**Title:** Proposal: East African payment gateways (Paystack, PalPluss, Pesapal) on the PaymentProvider seam

---

Hi, this is Moseti from Fikanova (Nairobi). Thank you for re-landing the PaymentProvider seam as [#40](https://github.com/emdashCommerce/dashcommerce/pull/40) and the EmDash 1.2 routing fix as [#45](https://github.com/emdashCommerce/dashcommerce/pull/45), and for crediting the original work in both. Taking those from a stale fork onto current `main`, and tightening them against review, was more work than writing them.

We want DashCommerce to be usable by merchants in Kenya and the wider region. That means mobile money and local payment gateways alongside Stripe. Before opening any core PRs I would like to agree the shape with you, so each PR is one you already expect.

## What #40 left for later

#40's "Deliberately deferred" section lists:

1. POS and async polling (`checkout/status`, `reconcilePaymentAttempt`), with Paystack STK as a follow-up.
2. A settings UI for `settings:paymentProvider`.
3. Publishing to npm.
4. A per-provider webhook path (`/checkout/webhook/:provider`).

The gateways below need items 1 (the async polling part only; we are not proposing POS), 2 and 4. The core changes I am proposing come from that list, plus one small additive change to webhook verification.

## The gateways and what each one needs

Each gateway is its own package. It registers through `registerPaymentProvider()` on import, declares `capabilities` honestly (no coupons, Connect or subscriptions unless it really supports them), and works in integer minor units with the currency checked by `supportsCurrency()`.

| Gateway | What it is | Currencies | Fits the merged seam today? | Needs from core |
|---|---|---|---|---|
| **Paystack** | Hosted checkout; cards, M-Pesa and Pay with Pesalink in Kenya | KES, NGN, GHS, ZAR, USD | **Yes.** Webhook is HMAC-SHA512 of the raw body in `x-paystack-signature`, which `resolveWebhookProvider()` already routes. `getPaymentStatus` maps to `GET /transaction/verify/:reference`. | Provider settings UI (credentials per provider) |
| **PalPluss** | M-Pesa STK push (Kenya) | KES only | **No.** No redirect: the customer approves on their phone, so the order is pending until a callback or a status poll. Webhooks follow Standard Webhooks: `webhook-id`, `webhook-timestamp` and `webhook-signature`, HMAC-SHA256 over `id.timestamp.body`. That cannot be checked from one header string. | Async status and reconciliation; all headers in `verifyWebhook` |
| **Pesapal** | Hosted checkout; cards and mobile money across Kenya, Uganda, Tanzania, Rwanda | KES, UGX, TZS, RWF, USD and others | **Partly.** The IPN is **not signed**. It carries an `OrderTrackingId`, and the only trustworthy answer is `GetTransactionStatus`. The IPN can be registered as GET or POST, and the IPN id differs between sandbox and live. | Async status and reconciliation (status is the source of truth); a per-provider webhook path |

Kenyan bank transfers over PesaLink come through Paystack's Pay with Pesalink channel, so they need no separate package.

Every gateway PR will include a recorded run in the gateway's own test mode, not only stubbed HTTP.

## The three core changes, in order

Each one is a separate, small PR with no change to existing defaults. Stripe stays the default provider, and the Stripe path behaves exactly as now. Missing configuration fails loudly. Tests go through the real patched dispatch path, as in #45. CI must pass the 0.37, 1.1 to 1.5 matrix.

### 1. Provider settings UI with per-provider credentials

- A provider choice on the Settings page, backed by the existing `settings:paymentProvider` key. The default stays `stripe`.
- Credentials stored **per provider**, matching how `loadPaymentProviderCredentials(order.providerId)` already loads them for refunds. Switching the active provider never overwrites Stripe's keys, which keeps the in-flight Stripe path from #40's residual-risk note working.
- Each registered provider describes its credential fields (label, secret or not), so the page renders fields without core knowing about Paystack or Pesapal. Secrets are write-only in the UI.
- Saving a non-Stripe provider while `checkoutMode=embedded` is refused with a clear message, matching #40's checkout rule.

### 2. Async payment status and reconciliation

For gateways where the customer pays somewhere other than a redirect (STK push), or where the webhook is unsigned (Pesapal):

- `initCheckout` may return `{ kind: "pending", checkoutReference }`, which the types already allow. Core stores a payment attempt and returns a status URL instead of a redirect.
- A public `GET checkout/status` route returns only what the waiting page needs. The response is allowlisted, in line with #69 and #72.
- `reconcilePaymentAttempt` calls `getPaymentStatus` and applies the result through the **same** paid path as webhooks. That path is amount and currency re-check (`reconcilePaymentAmount`), `providerEventId` dedup, and idempotent order transition. Webhook and poll can arrive in any order, any number of times.
- A late payment, one that arrives after the attempt expired or the stock was released, is held for operator review rather than silently fulfilled. This matches how #40 holds a currency mismatch.

This exists as commit [`11de8d5`](https://github.com/FIKANOVA/dashcommerce/commit/11de8d52445c81c06596afd97b55d58a93d4cbb8) on our fork with tests. The PR would port it to current `main` **without** the POS parts.

### 3. Webhook verification sees all request headers (plus a per-provider path if you want it)

- Add `headers: Headers` to `VerifyWebhookInput` next to `signatureHeader`. This is additive: Stripe and existing adapters ignore it. PalPluss needs three headers, and most Standard Webhooks senders do too.
- Optionally `/checkout/webhook/:provider`, which pins the adapter by path. `?provider=` and signature-header routing stay as they are, so the documented Stripe dashboard URL keeps working. If you prefer `?provider=` only, we will leave the path out.

## Where should the gateway packages live? (your call)

The packages currently use the `@dashcommerce/*` scope, which is yours, so we want to ask before publishing anything. Two options, and we are happy with either:

**A. In this monorepo as `@dashcommerce/paystack`, `@dashcommerce/pesapal` and so on.**
- They are tested against core in the same CI matrix, and break visibly when core changes.
- They are discoverable next to Stripe, and the npm scope matches what the registry already expects for sibling gateways.
- The cost is maintainer review and release load for gateways you may not use. We would commit to being named maintainers for them (CODEOWNERS or similar) and to keeping them green.

**B. In Fikanova repositories as `@fikanova/dashcommerce-<gateway>`.**
- There is no review or release load on you. We version and publish them ourselves against core's public seam.
- The cost is that compatibility is tested downstream, after a core release, not before. Discovery would rely on a link from your README.

Which would you prefer? If B, would you accept a short "Community payment providers" section in the README?

## Existing work, for reference

These are not for review. They are written against an older interface and will be redone as the small PRs above.

- [`recovery/FIK-49-paystack-upstream-seam`](https://github.com/FIKANOVA/dashcommerce/tree/recovery/FIK-49-paystack-upstream-seam): the Paystack provider written for #40's interface.
- [`recovery/FIK-49-provider-settings-ui`](https://github.com/FIKANOVA/dashcommerce/tree/recovery/FIK-49-provider-settings-ui): a provider settings page (change 1).
- [`feat/fik-core-engine`](https://github.com/FIKANOVA/dashcommerce/tree/feat/fik-core-engine): the earlier PalPluss and Pesapal prototypes.

## Questions for you

1. Is the order above (settings UI, then async status, then all headers) right, and is each one small enough as described?
2. Are you happy with `headers` added to `VerifyWebhookInput`? Do you want `/checkout/webhook/:provider`, or `?provider=` only?
3. Gateway packages: option A or B?

Nothing gets opened against core until we hear from you. Thanks for looking.
