# Nondies separation and DashCommerce handover

Recorded: 29 October 2026 (Africa/Nairobi)
Related Nondies work record: FIK-29

## Decision

DashCommerce is an independent EmDash commerce product. It is no longer a
runtime, workspace or package dependency of Nondies. Nondies will use WTL for
its supported sports, account and commerce domains; WTL integration does not
alter DashCommerce's product roadmap, upstream relationship or independent
release process.

Nondies must not import this repository's package source, register its plugin,
copy its provider code, or use a DashCommerce order/payment/ticket ledger. Its
commerce pages are intentionally unavailable until WTL provides an authorised,
validated contract.

## Verified checkpoint

| Item | Value |
| --- | --- |
| Repository | `https://github.com/FIKANOVA/dashcommerce` |
| Branch | `feat/payment-provider-interface` |
| Pushed commit | `b775fb14147b3554c2bef3603c2b40ec02d4eb6b` |
| Upstream | `https://github.com/emdashCommerce/dashcommerce` |
| Core package | `@dashcommerce/core` |
| Reference storefront | `@dashcommerce/starter` |

Restore this committed checkpoint without relying on Nondies:

```bash
git clone https://github.com/FIKANOVA/dashcommerce.git
cd dashcommerce
git switch --detach b775fb14147b3554c2bef3603c2b40ec02d4eb6b
bun install
bun run typecheck
bun test
```

## What the current branch contains

The committed payment-provider work establishes a gateway-agnostic commerce
boundary while preserving Stripe behaviour:

- `PaymentProvider` types, registry, Stripe adapter and credential-free mock
  provider;
- checkout, webhook and refund routing through that provider boundary;
- idempotency and distinct checkout/payment/provider event identities;
- protected no-store order-status polling;
- currency capability checks and billing/shipping address fallback;
- generic POS boundaries and asynchronous payment reconciliation; and
- tests covering provider behaviour, route wiring, webhook deduplication and
  refund idempotency.

The product itself continues to provide EmDash plugin functionality for product
catalogues, carts, hosted checkout, orders, shipping, tax, coupons, inventory,
subscriptions, downloads, reviews, vendors, emails, reports and admin UI. See
the root README and `packages/core` for supported interfaces and setup.

## Active working-copy note

At the time of this note, the primary checkout has uncommitted changes in the
core settings/admin/checkout/sandbox paths and the starter checkout page. They
are deliberately not folded into this documentation commit. Before another
agent archives, rebases, force-pushes or uses them as a release baseline, their
owner must run the project's secret scan, tests and create a dedicated recovery
commit or bundle.

## Contribution rules

1. Work in a DashCommerce worktree, not a client repository.
2. Keep provider-specific code behind the `PaymentProvider` interface.
3. Run `bun run typecheck`, `bun run build` and `bun test` before a feature
   commit.
4. Never use Nondies credentials, data, routes or deployment resources.
5. Keep upstream-appropriate changes reviewable for the `emdashCommerce`
   project; do not make client-specific forks part of core.
