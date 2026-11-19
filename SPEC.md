# Spec: Provider-neutral payment setup and on-page checkout
Status: Approved (founder, 19 Nov 2026)        Date: 2026-11-19
Client: internal (open source: FIKANOVA/dashcommerce, for upstream emdashCommerce/dashcommerce)        Type: tool
Linear: FIK-59 (this work), stacked on FIK-58 (core enablement, fork PR #3); Paystack is FIK-57 (fork PR #2). SPEC.md and PROGRESS.md are fork-only: drop them before any upstream PR.

## Problem
DashCommerce assumes Stripe from the first screen to the last. A new merchant is told to "add a Stripe secret key". The storefront checkout refuses to work unless Stripe's keys are saved, and says "Pay with Stripe". On-page checkout is wired to Stripe's payment form alone. So an East African merchant who wants Paystack (card and M-Pesa) first can't set the store up in admin, can't take a payment from the storefront, and can't keep customers on their own site. FIK-58 made other providers possible in core. This makes them first-class from day one.

## Users
- **Merchant (admin):** installs DashCommerce, chooses a payment provider, enters its keys, copies the webhook URL, confirms the connection, and picks how customers pay (hosted page or on-page).
- **Customer (storefront):** checks out and pays with the store's provider, by redirect or on the page, on a phone first.
- **Provider package author:** declares what the setup screen and storefront need (fields, checkout styles, connection check, browser client) without touching core.
- **Existing Stripe merchants:** see no change.

## Decisions most likely to change (read first)

**D1. "Set up" is defined as** follows:
- the active provider has its secret key and webhook secret saved, and
- its connection check has passed at least once since those keys last changed. The settings API records `setup:keysSavedAt:<providerId>` whenever that provider's credentials are saved. A passing check records `setup:payments` as `{ providerId, checkedAt }`. Setup is done when `checkedAt` is later than `keysSavedAt` (no hash or copy of any secret is stored).

A provider without `checkConnection` counts as set up once both keys are saved. An install that already has Stripe secret and webhook keys counts as set up, so existing merchants never see the setup screen.

**D2. The `checkoutMode` setting keeps its values and keys.** `"hosted"` means the provider's hosted page. `"embedded"` now means on-page checkout with the active provider:
- **Stripe:** Elements, unchanged, through `checkout/create-intent`.
- **Others:** through `checkout/create-session`, which returns an on-page result.

There is no new setting and no migration.

**D3. Provider contract additions** (all optional, so existing providers keep working):

```ts
interface PaymentProvider {
  // existing …
  readonly description?: string;                 // one line for the setup screen
  readonly checkoutStyles?: readonly ("hosted" | "on_page")[];   // default ["hosted"]
  checkConnection?(ctx, credentials): Promise<{ ok: boolean; detail?: string }>;
}

type InitCheckoutResult =
  | { kind: "redirect"; … }        // existing
  | { kind: "pending"; … }         // existing
  | { kind: "on_page"; checkoutReference: string; client: Record<string, string> }; // new
```

- **Stripe** declares `["hosted", "on_page"]`, and `checkConnection` reuses `GET /account` (today's "Test Stripe connection").
- **Paystack** declares `["hosted", "on_page"]`. Its `on_page` result is `client: { accessCode }` from the same `/transaction/initialize` call.

**D4. The browser side of on-page checkout is a provider package's client entry.** For example, `@dashcommerce/paystack/checkout-client` registers itself on `window.DashCommerceCheckoutClients[providerId]` with:

```ts
open(client: Record<string, string>, callbacks: { onClosed(): void; onFinished(): void; onError(message: string): void }): void
```

- The site imports the client entry once in its checkout page's `<script>`, so Vite bundles it.
- Core's checkout component calls `open` for an `on_page` result.
- Paystack's client loads `https://js.paystack.co/v2/inline.js` **only when the customer presses Pay**, then calls `resumeTransaction(accessCode)`.
- **The browser callback never marks anything paid.** `onFinished` only sends the customer to the thank-you page, which already polls for the order. Payment is still confirmed only by the signed webhook plus a live verify.

## Scope
1. **First-run setup screen:** an admin page `Set up payments`. It is not in the sidebar. It is reached from a banner on the Dashboard and the Settings page, shown while D1 says "not set up". Steps:
   1. Choose a provider: a list of registered providers with label and description. It shows a warning if the provider doesn't support the store's default currency (`supportsCurrency`).
   2. Enter keys: the provider's `credentialFields`, saved through the existing settings API.
   3. Copy the webhook URL: built from the public site URL and plugin id, `…/checkout/webhook?provider=<id>`, with a copy button.
   4. Choose how customers pay: hosted or on-page. Only the provider's `checkoutStyles` are offered; it saves `checkoutMode`.
   5. Test connection: calls `checkConnection` and shows the result. On success it records `setup:payments`.
   6. Finish: links to Settings and the storefront.
2. **Admin API:**
   - `admin/setup/status` returns D1 state, the provider list (with `checkoutStyles` and currency support) and the webhook URL.
   - `admin/setup/check` runs `checkConnection` and records the result.
   - Both are admin-only.
3. **Settings page:**
   - The "Finish setup" warnings point to the setup screen.
   - "Test connection" works for the active provider: it is generic and replaces the Stripe-only ping when another provider is active.
   - The checkout-flow choice lists the active provider's styles.
4. **Storefront hosted checkout is provider-neutral:**
   - `HostedCheckoutForm` copy uses the active provider's label ("Pay with Paystack →", "You'll be redirected to Paystack…").
   - `config-check` adds `paymentProvider: { id, label, configured, checkoutMode }` and keeps its existing Stripe fields.
5. **Starter checkout gate:** `packages/starter/src/pages/checkout.astro` checks the active provider's keys, not Stripe's, and its subtitle names the active provider.
6. **On-page checkout in core:**
   - `create-session` returns the `on_page` result for a non-Stripe provider when `checkoutMode` is `embedded` and the provider declares `on_page`.
   - It returns a clear 409 when the provider doesn't declare `on_page`. This replaces today's blanket Stripe-only refusal.
   - The storefront component handles `on_page` through the client registry (D4).
7. **Paystack on-page:**
   - `checkoutStyles`, an `on_page` init result, `checkConnection`, and the `checkout-client` entry, which lazy-loads `inline.js`.
   - The starter's checkout page imports the client in the e2e branch, and the README documents it for sites.
8. **Starter test setup** (test branch `test/FIK-57-paystack-e2e`, not upstream):
   - The starter registers both Stripe (built in) and Paystack, imports Paystack's checkout client, and allows both providers' hosts.
   - The merchant can switch the active provider and checkout style in Settings or the setup screen, and test all four combinations:
     1. Stripe hosted.
     2. Stripe embedded (Elements).
     3. Paystack hosted.
     4. Paystack on-page (Popup).
   - The manual script has a section for each, plus switching providers between runs.
9. **Tests:**
   - The new routes and contract are tested through the real route harness.
   - The client entry is tested with a fake `PaystackPop`.
   - The manual e2e script gains an on-page section and a fresh-install section.

## Non-goals
- PalPluss, Pesapal or PesaLink packages. The contract must fit them, but they are not built here.
- Changes to Stripe Elements (Stripe's on-page form) or Stripe's embedded flow.
- Letting the customer choose between providers at checkout, or more than one active provider at a time.
- The Charge API (Paystack's build-your-own form) and direct M-Pesa STK push without Paystack's UI.
- DashCommerce Lite (the sandboxed edition) and its storefront kit.
- POS, subscriptions on non-Stripe providers, and Stripe Connect for other providers.
- Renaming settings keys, changing the Stripe default, or migrating stored data.
- The known follow-ups: refund idempotency per admin click, `refundedAmount`, and the generic 500 on provider errors at checkout.
- npm publishing.

## Constraints
- **Upstream compatibility:** the matrix is EmDash 0.37 and 1.1 to 1.5. The maintainer wants small PRs, nothing about existing defaults changes, and requirements that are missing fail loudly.
- **Sandbox-safe server code:** no Node built-ins, `ctx.http.fetch` only, Web Crypto. The browser client runs only in the storefront.
- **Mobile first:** the setup screen and the checkout/Popup flow must work at 360px. M-Pesa customers are mostly on phones.
- **Light pages:** Paystack's `inline.js` loads only when Pay is pressed, never on page load.
- **Process:** test keys only, no real money. British English. Commits read `type(scope): [FIK-58|FIK-57] summary`. The founder's manual end-to-end run comes before anything goes upstream.
- **PR shape upstream:** stacked branches, one per concern:
  - provider enablement (done);
  - setup screen and neutral storefront;
  - on-page contract;
  - Paystack.
  The final split into upstream PRs is decided at posting time.

## Acceptance criteria
- [ ] **Fresh install** (no provider chosen, no Stripe keys): Dashboard and Settings show a "Set up payments" banner linking to the setup screen.
- [ ] **Existing Stripe install** (Stripe secret and webhook keys saved): no banner, no setup prompt, and Settings shows the Stripe card exactly as before.
- [ ] **Provider list:** the setup screen lists every registered provider. Choosing Paystack shows only Paystack's fields; a `pk_` key is refused with the server's message.
- [ ] **Currency warning:** if the store's default currency isn't supported by the chosen provider, the setup screen warns before saving.
- [ ] **Webhook URL:** the screen shows the correct `…?provider=<id>` URL for the site's public URL and plugin id, and the copy button copies it.
- [ ] **Checkout styles:** only the provider's declared styles are offered. Saving on-page sets `checkoutMode` to `embedded`.
- [ ] **Connection check, failure:** "Test connection" with wrong keys shows the provider's error and doesn't mark setup done.
- [ ] **Connection check, success:** with valid test keys it records `setup:payments`, and the banner disappears.
- [ ] **Re-check:** changing the provider's keys afterwards marks setup as needing a fresh check.
- [ ] **Settings connection test:** on Settings, "Test connection" tests the active provider (Paystack when Paystack is active, Stripe's existing ping when Stripe is active) and shows its result.
- [ ] **Neutral storefront:** with Paystack active and no Stripe keys, `/checkout` renders a working checkout. The button reads "Pay with Paystack →" and no text mentions Stripe.
- [ ] **Stripe storefront unchanged:** with Stripe active, `/checkout` text and behaviour are unchanged; existing core and starter tests pass unmodified.
- [ ] **On-page result:** with Paystack and on-page selected, `create-session` returns `kind: "on_page"` with an `accessCode`. Pressing Pay loads `inline.js` once and opens Paystack's checkout over the page.
- [ ] **Popup outcomes:**
  - After a successful on-page payment the customer lands on the thank-you page, and the order appears only after the webhook and verify.
  - Closing the Popup leaves the customer on checkout, able to retry, and creates no order.
- [ ] **Four-way starter matrix:** on the test branch with Stripe and Paystack test keys both saved, a test payment completes and creates exactly one paid order in each combination:
  - [ ] Stripe hosted.
  - [ ] Stripe embedded.
  - [ ] Paystack hosted.
  - [ ] Paystack on-page.
- [ ] **Switching provider:** after switching the active provider, an order paid with the previous provider can still be refunded and its late webhooks still verify.
- [ ] **No on-page support:** a provider without `on_page`, with `checkoutMode=embedded`, gets a 409 naming the provider. The setup screen never offers it.
- [ ] **Lazy load:** `inline.js` isn't requested on page load. The checkout page's LCP stays under 2 s on Fast 3G throttling.
- [ ] **360px:** the setup screen, the checkout page and the Popup flow work at 360px with keyboard and touch, and all inputs are labelled.
- [ ] **Checks:**
  - Typecheck, `bun test` (core, Lite, Paystack) and build pass under bun 1.4.3, with new tests for every new route, contract branch and the client entry.
  - `betterleaks` finds only obviously fake fixtures.
- [ ] **Standing web checks:**
  - [ ] Semantic HTML on the new screen.
  - [ ] Checkout stays `noindex`; JSON-LD doesn't apply to admin or checkout.
  - [ ] No secrets in the repo.

## Open questions (with working assumptions)
0. **Stripe test keys.** Resolved: the founder has Stripe test keys; the four-way run includes Stripe.
   - *Assume:* the founder has a Stripe test account.
   - *If not:* the Stripe half is skipped and recorded as not run.
1. **Paystack `checkConnection` with a restricted key.** Which endpoint can an `rk_` key with only `transactions:write` and `disputes_refunds:write` call?
   - *Assume:* `GET /transaction?perPage=1`.
   - If the restricted key is refused, report "connection OK, but this key can't list transactions" rather than fail. Confirm in the manual run.
2. **M-Pesa inside the Popup.** The docs say the Popup lets the customer choose a channel, but don't list Kenyan channels.
   - *Assume:* M-Pesa appears in the Popup like on the hosted page. The manual run confirms it.
3. **Webhook URL with a custom plugin id.** *Assume* the admin page can read its own plugin id and the public site URL from the existing settings or `getPublicSiteUrl`. If not, the screen shows the path and asks the merchant to prefix their domain.
4. **Where the banner lives.** *Assume* a Dashboard widget slot and the Settings page are enough. No EmDash-wide banner.
5. **Content-Security-Policy.** *Assume* sites have no CSP blocking `js.paystack.co`. The README notes the origins to allow if they do.
