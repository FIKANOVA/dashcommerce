# @dashcommerce/core

The e-commerce plugin for [EmDash CMS](https://github.com/emdash-cms/emdash).

**Current npm version: 0.3.4.** See the monorepo README for the full feature list and quick start, or [dashcommerce.dev/docs](https://dashcommerce.dev/docs) for guides. Live demo: [demo.dashcommerce.dev](https://demo.dashcommerce.dev).

## Package exports

| Entry | Context | Purpose |
|---|---|---|
| `.` | Vite / build time | Descriptor factory (`dashcommerce()`) — imported in `astro.config.mjs`. Side-effect-free. |
| `./sandbox` | Runtime server | `definePlugin({ hooks, routes })` loaded by the emdash runtime. Sandbox-safe. |
| `./admin` | Browser | React admin pages + dashboard widgets + field widgets. |
| `./astro` | Host SSR | `blockComponents` registry for Portable Text block renderers, and `storefrontCurrency(Astro.cookies)`: the cart's currency (from the `dashcommerce_currency` cookie that cart responses set), to pass as `currency` to `<ProductDetails>`, `<ProductCard>` and `<ProductGrid>`. Pages that use it vary by that cookie, so a page cache must too. |
| `./astro/components/*` | Host SSR | Storefront Astro components (`<ProductCard>`, `<CartSummary>`, etc.). |
| `./astro/islands/*` | Host SSR + client | React islands (`CartDrawerIsland`, `CheckoutIsland`, etc.). |

## Install

Four steps to add DashCommerce to an existing EmDash + Astro site:

```sh
bun add @dashcommerce/core
```

Register the plugin in `astro.config.mjs`:

```ts
import { dashcommerce } from "@dashcommerce/core";

emdash({ plugins: [dashcommerce()] });
```

Merge the products collection + taxonomies into your seed file, then re-apply:

```sh
bunx dashcommerce-merge-seed
bun emdash seed --on-conflict=update
```

Open `/_emdash/admin/plugins/dashcommerce/settings` and paste your Stripe test keys.

**Want sample data?** Add `--with-demo-catalog` to the merge step to seed six demo products (one per product type) plus `product_category` and `product_tag` terms, so the admin isn't empty on first boot:

```sh
bunx dashcommerce-merge-seed --with-demo-catalog
bun emdash seed --on-conflict=update
```

Re-running is safe — existing products with matching ids are preserved. Swap or delete the demo entries any time from the Products admin.

For a fully-wired reference setup (seed data, storefront pages, Stripe keys), see [`@dashcommerce/starter`](../starter). Full walkthrough: [dashcommerce.dev/docs/getting-started](https://dashcommerce.dev/docs/getting-started).

## Other payment providers

Stripe is built in. A gateway package (for example `@dashcommerce/paystack`) registers its provider with `registerPaymentProvider` when it is imported. For a site:

1. **Import the package where the server runtime loads it before any request**, such as `src/middleware.ts`. Importing it in `astro.config.mjs` is not enough, because that file runs only at build time.
2. **Allow the provider's API host**, which is added to Stripe's hosts and never replaces them:

   ```ts
   emdash({ plugins: [dashcommerce({ allowedHosts: ["api.paystack.co"] })] });
   ```

3. **Choose the provider and enter its keys** in Settings → Payment provider. They are saved as `settings:<id>SecretKey` and `settings:<id>WebhookSecret`, masked like Stripe's.
4. **Point the provider's webhooks** at `/_emdash/api/plugins/dashcommerce/checkout/webhook?provider=<id>`.

For provider authors, `PaymentProvider` can declare:

- `credentialFields`: the label, accepted prefixes and help text for the settings form.
- `webhookHeaders`: the headers that identify its webhooks, besides `x-<id>-signature`. `verifyWebhook` receives every request header, and `credentials` (the provider's saved secret key and webhook secret) for headers signed with the API key rather than the webhook secret.
- `checkoutStyles`: `["hosted", "on_page"]` to offer checkout over the store's page. `initCheckout` then returns `{ kind: "on_page", client }`, and the storefront hands `client` to the provider's browser client. `client` is public: `create-session` sends it to the browser as JSON, so put only what the browser needs in it (Paystack sends `{ accessCode }`), never a secret key or webhook secret.
- `checkConnection`: one read-only call with the saved keys, behind a "Test connection" button in Settings. Return `{ ok, message }`, with `ok: false` and a message the merchant can act on for a wrong or under-permitted key.
- `capabilities.splits`: core computes `allocations` (`vendorId`, `accountReference`, `amountMinor`) and `platformRemainderMinor` when the cart has vendor-owned items. Vendors store their payout account under `paymentAccounts[providerId]`; the provider only routes the amounts core supplies.
- `listPayoutBanks`, `resolvePayoutAccount`, `createPayoutAccount`: optional provider-managed payout onboarding. The Vendors page lists banks or mobile-money channels, verifies the account name when the provider supports it, and creates the account; core stores the masked result on the vendor. A provider that creates an active but unverified account (Paystack's `is_verified: false`) should return `verified: false`; core still accepts it for splits.
- `splitSettlement` on a `charge.succeeded` event: optional provider-reported per-account amounts, platform remainder and fee. Core stores it on `Order.providerSplits` for reconciliation; it never changes the shares core computed.
- Keep your own transaction fee on the platform (Paystack's `bearer_type: account`, Flutterwave's default) so each vendor receives exactly the share core computed.
- `capabilities.subscriptions` plus optional `getSubscription`, `cancelSubscription` and `resumeSubscription`: core stores the provider's subscription/plan id from the first `charge.succeeded` that carries `subscription`, records later charges as invoices, and dispatches cancel/resume. Return `ProviderSubscriptionInfo`. A provider that cannot pause or change plans in place can omit those methods; core refuses the action with a readable error. When the provider refuses a cancel or resume (for example the subscription is already inactive there), throw `SubscriptionActionRefusedError` with the reason: `POST /admin/subscriptions/action` answers 409 with `{ error, code: "subscription_action_refused" }` instead of 500.
- `parseWebhookEvent` may return `subscription.updated` for a cancellation or status change outside a charge. Core updates the local row and does not create an order. If the provider's own subscription id differs from the one core stores, send it as `providerSubscriptionRef`: core remembers it whenever an event carries both ids, and matches a later event that carries only the ref.

- `inPersonMethods`, `listTerminals` and `startInPersonPayment`: counter sales (see "Counter sales" below). Declare `["phone"]`, `["terminal"]` or both. `startInPersonPayment` gets `{ orderDraftId, amount, currency, customer: { email, phone? }, method }` and returns `{ paymentReference, status }`; core then polls `getPaymentStatus(paymentReference)`, which a counter provider must implement. A `charge.succeeded` webhook for the payment must carry the same `paymentReference` and `orderDraftId`.

`parseWebhookEvent` may return `refund.updated` to move a pending refund to `succeeded` or `failed`. A failed refund stops counting against its order: the refunded total, payment status and order status are worked out again, and stock the refund put back is taken back off.

`parseWebhookEvent` may return `dispute.updated` when a customer disputes a payment (`providerDisputeId`, `paymentReference`, `status` of `open`, `won` or `lost`, `amount` in minor units, `currency`, and `reason` and `dueAt` when known). Core records the dispute on the order paid through that provider, emails the store's admin users once when a new dispute opens (amount, deadline, "answer it in your <provider> dashboard"), and counts a lost dispute like a refund, without emailing the customer. Give each dispute status change its own `providerEventId` so a repeat delivery is skipped but the next status is not. The Stripe adapter maps `charge.dispute.created`, `charge.dispute.updated` and `charge.dispute.closed`.

Event-level dedup skips a repeated delivery even if the first one failed, so a duplicate side effect never runs. The exception is a failure to confirm the payment with the provider (`getPaymentStatus` throwing or not reporting paid). That failure happens before any side effect, so the provider's retry is processed.

If the provider refuses the cart's currency (an account not enabled for it, say), throw `CurrencyNotSupportedError` from `initCheckout`. Core answers `create-session` with a 400 that tells the customer to choose another currency, instead of a 500.

## Seed merge CLI

`@dashcommerce/core` ships a `dashcommerce-merge-seed` binary (on your `PATH` via `node_modules/.bin`). It writes the `products` collection and `product_category` / `product_tag` taxonomies into your EmDash `seed.json`, replacing any prior DashCommerce entries by slug / name. Unrelated keys in the seed file (settings, content, menus, other collections) are left intact.

```sh
# Typical one-liner after emdash init (fresh DB)
bunx dashcommerce-merge-seed && bun emdash seed --on-conflict=update
```

Or add to `package.json`:

```json
"scripts": {
  "bootstrap": "dashcommerce-merge-seed && bun emdash seed --on-conflict=update"
}
```

Why `--on-conflict=update`? On a first run it's a no-op, but subsequent runs (after a DashCommerce release that tweaks the `products` schema) need it to update the collection in place rather than skipping it.

Options: `--seed <path>` (override file), `--cwd <dir>`, `--with-demo-catalog` (append 6 demo products + curated taxonomy terms). When `--seed` is omitted the CLI uses the same default resolution as `emdash seed`: `.emdash/seed.json` if present, otherwise `package.json` → `emdash.seed`.

Prefer to assemble the seed in TypeScript? Import `mergeDashCommerceSeed(seedObject, { withDemoCatalog })` from the package root — same dedupe rules as the CLI. The demo catalog is also exported directly as `DEMO_PRODUCTS`, `DEMO_PRODUCT_CATEGORY_TERMS`, and `DEMO_PRODUCT_TAG_TERMS` for cherry-picking.

## Runtime surface

### Public routes (storefront)

All paths mount under `/_emdash/api/plugins/dashcommerce/`.

```
GET    /cart                              Current cart (creates if missing; re-runs recalculate)
POST   /cart/items                        Add line item
PATCH  /cart/item?lineId={id}             Update qty
DELETE /cart/item?lineId={id}             Remove line
DELETE /cart/clear                        Empty cart (keeps session)
POST   /cart/currency                     Switch currency (empty cart only)
POST   /cart/coupon                       Apply coupon
DELETE /cart/coupon/remove?code={code}    Remove coupon
POST   /cart/shipping-location            Set country + region + postal (hosted checkout pre-flight)
GET    /cart/shipping-regions             Regions the shipping zones name, by country
POST   /cart/shipping-address             Full address (embedded checkout)
POST   /cart/contact                      Email + billing address
POST   /cart/shipping-methods             List rates for current ship-to
POST   /cart/shipping-method              Choose method id
GET    /cart/restore?token={t}            Abandoned-cart recovery link

POST   /checkout/create-intent            Embedded Elements: create PaymentIntent
POST   /checkout/create-session           Hosted Checkout: create Checkout Session
GET    /checkout/mode                     Which mode is active (hosted | embedded)
POST   /checkout/webhook                  Stripe webhook sink (signature-verified)

GET    /orders/by-draft?id={draftId}      Poll order status after checkout

GET    /downloads/serve?token={t}         Signed-URL download delivery

GET    /reviews/list?productId={id}       Paginated reviews
POST   /reviews/item                      Submit a review (moderation queue)

GET    /config-check                      Read-only health check (Stripe keys present, etc.)
```

### Admin-gated routes

Same prefix, gated by emdash's admin auth:

```
GET    /admin/settings                    Read all settings:* keys
POST   /admin/settings                    Write (validated via schema)
POST   /admin/stripe/ping                 Live-key sanity check
POST   /admin/payments/check-connection   Same check for another provider ({ providerId })
GET    /admin/orders, /admin/orders/:id   Order list + detail
POST   /admin/orders/:id/refund           Full or partial refund
PATCH  /admin/orders/:id/status           Transition order status (triggers review-request etc.)
GET    /admin/customers …                 Customer CRUD
GET    /admin/reports/revenue             Range-sliced revenue with comparison
GET    /admin/reports/top-products        Best sellers by qty or revenue
GET    /admin/reports/top-customers       Lifetime-value leaderboard
GET    /admin/reports/mrr                 Active subscription MRR by currency
… plus coupons, vendors, shipping zones/methods, tax rates, subscriptions, reviews moderation, menu, customer-portal-session
```

### Hooks

- `content:beforeSave` on the `products` collection — field validation (price map, variants, stock, shipping class)
- `cron` — stock-lock sweep (5 min), abandoned-cart reminders (hourly), subscription renewals dry-check
- `plugin:install` — seed default settings (`taxMode=flat`, currencies, download TTLs, etc.)
- `plugin:activate` — assert Stripe keys present; emit config warnings if not

### Plugin storage collections

19 collections declared in [`storage-collections.ts`](./src/storage-collections.ts):

```
orders · order_items · order_refunds · customers · customer_addresses
product_variants · inventory_ledger · stock_locks
coupons · coupon_usages · shipping_zones · shipping_methods · shipping_classes
tax_rates · reviews · subscriptions · vendors · vendor_payouts · download_grants
```

Plus one *content* collection declared by the host via `defineProductsCollection()`:

```
products  (lives on host content, not plugin storage — emdash restriction)
```

### KV namespaces

Prefixes `ctx.kv` uses under the hood:

```
settings:*                  plugin configuration (tax mode, currencies, Stripe keys, etc.)
cart:{sessionId}            active carts (30-day TTL via cookie)
lock:{productId}:{variant}  stock soft-locks during checkout
abandoned:{sessionId}       abandoned-cart marker (sent / not sent)
email-throttle:{category}:* per-customer email de-duplication keys
```

## Admin surface

React pages served at `/_emdash/admin/plugins/dashcommerce/*`:

- Orders (list, detail, refund, status transitions, online or counter filter)
- Counter sale (sell in person: phone prompt or card terminal)
- Customers (list, detail, order history)
- Coupons (CRUD + usage reports)
- Shipping (zones + methods + classes)
- Tax (mode + flat rate + rate table + Stripe Tax status)
- Subscriptions (list, detail, pause/resume, invoice history)
- Reviews (moderation queue, bulk approve/reject)
- Vendors (invite, onboarding status, payout history)
- Menus (storefront nav editor, nested up to 4 levels)
- Reports (revenue + top products + top customers + MRR)
- Settings (all `settings:*` keys with per-key validation)
- Dashboard widgets: Revenue, Low Stock, Recent Orders, Pending Reviews, Failed Renewals

Refunds and payment settings are for EmDash Admins only. EmDash already sends every DashCommerce admin route through its `plugins:manage` permission, which only Admins hold, so Editors and below get a 403 from EmDash before DashCommerce runs. DashCommerce checks the caller's role (`ctx.user.role`) again on the money routes, so they stay admin-only if other admin routes are later opened to Editors:

- `POST /admin/orders/refund` — 403 "Only an admin can issue refunds."
- `POST /admin/settings` with the payment provider, checkout mode, Stripe keys or a provider's keys — 403 "Only an admin can change payment settings." Other settings save as before.
- `POST /admin/stripe/ping` and `POST /admin/payments/check-connection` — admin-only, since only an admin can set the keys they test.
- `POST /admin/subscriptions/action` (cancel, resume) — 403 "Only an admin can change a subscription."
- Vendor payout changes: `POST`/`PATCH /admin/vendors/item`, `/admin/vendors/onboard-link`, `/admin/vendors/payout-account` and its `/resolve` — 403 "Only an admin can manage vendor payouts." Listing vendors stays open.

A call with no signed-in user is refused. The order detail and settings responses carry `canRefund` and `_canManagePayments`, so the admin shows non-admins a short note instead of the refund form and greys out the payment cards.

### Counter sales

The **Counter sale** page sells in person from the same products and stock as the shop. Staff add products, then choose how the customer pays: a prompt on the customer's phone (M-PESA through Paystack), or a card terminal when the provider lists one. Stock is held while the customer pays (15 minutes at most). The page checks `admin/counter/status` every 3 seconds and shows "Paid. Order 1042", or "Cancelled or declined" / "Timed out" (after 5 minutes) with a Retry button; a failed or timed-out sale releases the stock. If the customer still pays after a time-out, the order is still created: by the webhook, or by the status check, which asks the provider again about a timed-out sale and about any terminal sale (a card can be tapped after the page stops waiting). The page keeps checking a failed terminal sale, warns before "New sale" drops one that may still be paid, and Retry sends `retryOf`: the route refuses with 409 if the earlier attempt was paid or is still waiting, and links the two so a second payment is held for review.

The webhook and the status check can confirm the same payment at once. Order creation first claims the payment (a row with a unique key in the webhook dedup log), so the second caller stops before any side effect and is answered as a duplicate; a failed creation releases the claim.

The order is created through the same path as an online order (stock, coupons, receipt email), from the signed webhook or the status check, whichever confirms first. It carries `channel: "in_person"` and `soldBy` (the seller's EmDash user id); `GET /admin/orders?channel=in_person` (or `online`) filters by it. A sale with no customer email uses the seller's own email for the provider and the receipt. Subscription and vendor-owned products are sold online only for now, and the product list covers simple prices (not variant pickers) and scans up to 200 products.

```
GET    /admin/counter/setup               Provider, methods, terminals, currency
GET    /admin/counter/products?q=         Products priced in the shop currency
POST   /admin/counter/sale                { lines, method, customerEmail?, currency? }
GET    /admin/counter/status?draft={id}   pending | paid (orderNumber) | failed (declined | timed_out)
```

The counter routes allow Editors and Admins (`ctx.user.role` 40 or more) and refuse anyone else, or a call with no user, with 403. Refunds of counter sales stay admin-only. EmDash 0.x and 1.x send every non-public plugin route through `plugins:manage`, so until EmDash lets a plugin route ask for a lesser permission, only Admins reach these routes in practice.

The admin follows the EmDash admin's light or dark mode: its colours come from EmDash's theme tokens, with light fallbacks for hosts without them. It uses CSS `color-mix()`, so it needs a browser from 2023 or later (Chrome 111, Safari 16.2, Firefox 113).

To restyle it, set any of these CSS variables in your admin: `--dc-card-bg`, `--dc-card-fg`, `--dc-text-muted`, `--dc-text-subtle`, `--dc-label`, `--dc-input-bg`, `--dc-input-fg`, `--dc-border`, `--dc-hairline`. Status badges, destructive buttons, dialog backdrops and shadows use fixed colours that read the same in both modes.

Field widgets (for use in any collection via `widget: "dashcommerce:<name>"`):

- `vendor-select` — picks a vendor from `vendors` storage
- `price-map` — multi-currency price input, respects `settings:enabledCurrencies`

Portable Text blocks (for any rich-text field):

- `product-embed` — single product card by slug
- `product-grid` — N products from a category slug
- `review-quote` — inline quote of an approved review

## Events & emails

The plugin sends these transactional emails via `ctx.email.send` (HTML + plain text):

| Event | Template | Triggered by |
|---|---|---|
| Order receipt | `emails/receipt` | Webhook `charge.succeeded` / `checkout.session.completed` |
| Refund | `emails/refund` | Webhook `charge.refunded` or admin refund POST |
| Subscription renewed | `emails/subscription-renewed` | Webhook `invoice.payment_succeeded` (cycle only) |
| Dunning | `emails/dunning` | Webhook `invoice.payment_failed` |
| Abandoned cart | `emails/abandoned-cart` | Hourly cron, per `settings:abandonedCartDelayHours` |
| Review request | `emails/review-request` | Order status → `completed` on physical items |
| Vendor invite | `emails/vendor-onboarding` | `startOnboarding()` in `vendors/onboarding.ts` |
| Vendor activated | `emails/vendor-onboarding` | Webhook `account.updated` when `chargesEnabled` flips true |
| Vendor payout | `emails/vendor-payout` | Webhook `payout.paid` |

All senders are idempotent via `ctx.kv` de-dup keys.

## Development

```sh
bun install
bun run typecheck
bun run build          # tsdown bundles index + sandbox-entry + admin/entry
bun run dev            # tsdown --watch
bun test               # 66 tests across money / cart / coupons / webhook / tokens / split
```

`src/astro/` is shipped as source — it is NOT bundled. It imports `.astro` components that rolldown can't compile; the host's Astro build resolves the imports at consumer build time.

## License

MIT
