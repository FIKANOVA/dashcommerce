# Response to Maintainer Review on PR #18 (`feat/payment-provider-interface`)

**To:** `@cavewebs`  
**From:** Fikanova Engineering (`@nya-onmoseti`)  
**PR:** [emdashCommerce/dashcommerce#18](https://github.com/emdashCommerce/dashcommerce/pull/18)  
**Status:** Local verification complete (186/186 tests passing, monorepo build & typecheck clean). Pending local sign-off prior to GitHub push.

---

Hi @cavewebs,

Thank you for the thorough and constructive architectural review on PR #18. We have addressed every item from your feedback directly on the PR branch, backed by automated regression tests in `packages/core` and proven with an external consumer package (`@dashcommerce/paystack`).

Below is the detailed point-by-point breakdown mapping each feedback item to its implementation and test coverage.

---

## 1. Six Primary Blockers

### 1.1 Reference Separation (`checkoutReference` vs `paymentReference`)
- **Review Feedback:** Conflating checkout session identifiers with captured payment references breaks downstream accounting and causes invalid refund targets (e.g. attempting to refund a Stripe Checkout Session ID `cs_test_...` instead of a Charge or PaymentIntent ID `pi_...` / `ch_...`).
- **Resolution:**
  - Separated `checkoutReference` (the provider's transient session/initiation ID) and `paymentReference` (the settled capture/charge reference) across all types (`InitCheckoutResult`, `NormalizedPaymentEvent`, `OrderDraft`, and `Order`).
  - In `StripePaymentProvider`, `initCheckout` returns `checkoutReference: session.id`. The webhook parser maps `session.payment_intent` into `paymentReference`.
  - The `refund()` method explicitly accepts and requires `paymentReference` (the PaymentIntent/Charge ID), ensuring Stripe Session IDs are never targeted for refunds.
- **Commit:** `631e9da` (`fix(core): tighten PaymentProvider seam to address maintainer review blockers`)
- **Tests:** `packages/core/src/payment-provider/stripe-provider.test.ts` ("refund: requires refundRequestId and calls Stripe with idempotency key", "refund: throws if refundRequestId or paymentReference is missing").

---

### 1.2 Event Identity & Deduplication (`providerEventId` + `eventIdSource`)
- **Review Feedback:** Inbound webhook events need explicit deduplication identifiers. Webhooks without event IDs must not be assigned arbitrary UUIDs that defeat deduplication.
- **Resolution:**
  - Added `providerEventId: string` and `eventIdSource: 'native' | 'derived'` to `NormalizedPaymentEvent`.
  - Stripe events preserve the native Stripe event ID (`evt_...`, marked as `native`).
  - For providers lacking native webhook IDs (or mock tests), deterministic keys are derived from `providerId:account:reference:status` (marked as `derived`).
  - Event deduplication and order fulfillment idempotency are decoupled: events are recorded by `providerEventId` before state transitions execute.
- **Commit:** `631e9da`
- **Tests:** `packages/core/src/payment-provider/mock-provider.test.ts` ("mock: parseWebhookEvent round-trips charge.succeeded with event identity and separated references").

---

### 1.3 Checkout Option Parity via Typed `providerOptions`
- **Review Feedback:** The generalized interface flattened Stripe-specific options, dropping subscription trials, Stripe Tax, and Stripe Connect parameters (`transfer_data`, `application_fee_amount`).
- **Resolution:**
  - Added typed `providerOptions?: PaymentProviderCheckoutOptions` to `InitCheckoutInput`.
  - The Stripe adapter passes through `subscription`, `tax`, and `connect` (`destinationAccountId`, `applicationFeeAmount`, `transferGroup`) preserving the exact Stripe API nesting.
  - Providers validate capabilities before initiation: non-Stripe providers reject unsupported checkout options upfront with typed validation errors rather than silently discarding them.
- **Commit:** `631e9da`
- **Tests:** `packages/core/src/payment-provider/stripe-provider.test.ts` ("initCheckout: passes Stripe checkout options and returns redirect result").

---

### 1.4 Mandatory `refundRequestId` for Idempotency
- **Review Feedback:** `refundRequestId` was optional, allowing non-idempotent refund retries.
- **Resolution:**
  - Made `refundRequestId: string` strictly mandatory in `CreateRefundInput`.
  - Passed down as the `Idempotency-Key` header in the Stripe client wrapper, preventing duplicate refund debits on network retries or process restarts.
- **Commit:** `631e9da`
- **Tests:** `packages/core/src/payment-provider/stripe-provider.test.ts` ("refund: requires refundRequestId and calls Stripe with idempotency key").

---

### 1.5 Duplicate Provider Registry Collision Guard
- **Review Feedback:** Calling `registerPaymentProvider()` with an existing provider ID silently overwrote the registered instance, risking unexpected runtime side-effects during plugin initialization.
- **Resolution:**
  - `registerPaymentProvider(provider, options?)` now checks existing registrations and throws `PaymentProviderError('PROVIDER_ALREADY_EXISTS')` by default.
  - Replacement is only permitted if `{ override: true }` is explicitly passed in options.
  - Empty or whitespace-only provider IDs are validated and rejected.
- **Commit:** `631e9da`
- **Tests:** `packages/core/src/payment-provider/registry.test.ts` ("registry: rejects duplicate provider registration unless override is explicit", "registry: rejects empty or whitespace-only provider IDs").

---

### 1.6 Currency Capability via `supportsCurrency(currency: string)`
- **Review Feedback:** Fixed enum currency lists failed for multi-currency or regional gateways where supported currencies vary dynamically or by merchant account.
- **Resolution:**
  - Replaced currency enum checks with `supportsCurrency(currency: string): boolean` on `PaymentProvider`.
  - Normalizes input case-insensitively (e.g. `'usd'`, `'USD'`).
  - Core checkout initiation routes validate currency support before creating external sessions.
- **Commit:** `631e9da`
- **Tests:** `packages/core/src/payment-provider/stripe-provider.test.ts` ("supportsCurrency: validates 3-letter ISO currency codes").

---

## 2. Five Secondary Issues Addressed

### 2.1 Billing Address Fallback
- **Resolution:** In `StripePaymentProvider.parseWebhookEvent()`, `session.customer_details.address` is mapped to `billingAddress`. For carts where only shipping or billing address is present (e.g. digital goods), fallback between `billingAddress` and `shippingAddress` is maintained without dropping data.
- **Commit:** `631e9da`
- **Tests:** `packages/core/src/payment-provider/stripe-provider.test.ts` ("parseWebhookEvent: checkout.session.completed maps customer address to billingAddress and preserves fallback", "parseWebhookEvent: digital cart with billingAddress only falls back to shippingAddress").

### 2.2 Mock Redirect URL Construction
- **Resolution:** Updated mock redirect URL construction to use standard `URL` and `searchParams.set("mock", "1")`, correctly preserving base paths, existing search parameters, and URL hash fragments.
- **Commit:** `631e9da`
- **Tests:** `packages/core/src/payment-provider/mock-provider.test.ts` ("mock: initCheckout succeeds by default, separates references, and formats clean redirect URLs").

### 2.3 Malformed Webhook JSON Handling
- **Resolution:** Malformed or non-JSON payloads sent to webhook endpoints are caught safely and return the documented `{ type: 'unhandled', raw: payload }` event instead of leaking an uncaught JSON parse error.
- **Commit:** `631e9da`
- **Tests:** `packages/core/src/payment-provider/stripe-provider.test.ts` ("parseWebhookEvent: unparseable body maps to 'unhandled' rather than throwing").

### 2.4 Removal of CI Test Step Failure Masking
- **Resolution:** Removed `continue-on-error: true` from the test step in `.github/workflows/ci.yml`. Any test failure now cleanly and immediately fails the CI pipeline.
- **Commit:** `649bb32` (`fix(ci): make test step failures blocking by removing continue-on-error`)

### 2.5 Route Wiring and Scope Transparency
- **Resolution:** Wired generic checkout initiation, webhook processing, order status polling (`/checkout/status`), and refund execution routes directly to the `PaymentProvider` seam in a separate, reviewable commit (`c8c9b2d`). The PR description has been updated to reflect the full extensibility scope.
- **Commit:** `c8c9b2d` (`feat(core): wire checkout, webhook, and refund routes to PaymentProvider seam`)

---

## 3. External Consumer Proof: `@dashcommerce/paystack`

To prove the core extensibility seam functions end-to-end without requiring any core internal modifications or switch statements:
- Developed `@dashcommerce/paystack` as an external package.
- Implements `PaymentProvider`:
  - `initCheckout` with Paystack standard checkout initialization.
  - Webhook verification via HMAC-SHA512 (`x-paystack-signature`).
  - Webhook parsing mapping `charge.success` to `charge.succeeded` with native event ID and reference separation.
  - Refund initiation via Paystack refunds API with idempotency tracking.
  - Case-insensitive `supportsCurrency` check for supported African and international currencies.
- **Commit:** `3ded3d2` (`feat(paystack): add external Paystack PaymentProvider package with checkout, webhook, and refund support`)

---

## 4. Verification & Test Evidence

All checks have been executed locally across the entire monorepo:
1. **Automated Unit & Integration Tests:**
   ```bash
   bun test
   # 186 pass, 0 fail, 478 expect() calls across 26 files (843ms)
   ```
2. **TypeScript Compilation:**
   ```bash
   bun run typecheck
   # All packages (@dashcommerce/core, paystack, palpluss, pos, create, starter) compile clean (0 errors).
   ```
3. **Monorepo Build:**
   ```bash
   bun run build
   # All packages and the Astro Cloudflare starter built cleanly without errors.
   ```

We look forward to your thoughts and are ready to push the updated commits once you confirm.
