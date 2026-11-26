/**
 * CheckoutFormIsland — Stripe Elements checkout.
 *
 * The amount is fixed when the customer presses Pay, as with every other
 * payment provider (Stripe's deferred-intent flow):
 *   1. Wait until the cart has `customerEmail` + `shippingAddress` set
 *      (the contact form on /checkout saves those, then dispatches
 *      `dashcommerce:cart-updated`).
 *   2. Render <Elements> in `mode: "payment"` with the cart's current
 *      amount and currency. No PaymentIntent exists yet. The amount follows
 *      the cart: a coupon or shipping change at checkout updates it.
 *   3. On Pay: `elements.submit()` validates the card form, then
 *      POST /checkout/create-intent re-prices the cart on the server and
 *      creates the PaymentIntent for that total. If the cart hasn't
 *      changed since the last attempt (say, after a decline), the same
 *      intent is reused.
 *   4. `stripe.confirmPayment` with that client secret; Stripe handles 3DS
 *      and returns the customer to `returnUrl` with "{orderDraftId}"
 *      substituted, where the thank-you page polls for the order.
 *
 * Peer-optional: @stripe/react-stripe-js + @stripe/stripe-js are lazy-
 * imported inside the island so sites that don't use DashCommerce
 * checkout don't need to install them.
 */

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

export interface CheckoutFormIslandProps {
	publishableKey: string;
	returnUrl: string;
}

interface Money {
	amount: number;
	currency: string;
}

/** The parts of the cart the payment form reads. */
export interface PayableCart {
	customerEmail?: string;
	shippingAddress?: unknown;
	total: Money;
	currency: string;
	updatedAt?: string;
}

/** A PaymentIntent created by checkout/create-intent. */
export interface CreatedIntent {
	clientSecret: string;
	orderDraftId: string;
	paymentIntentId: string;
	total: Money;
	currency: string;
	cartUpdatedAt?: string;
}

const API = "/_emdash/api/plugins/dashcommerce";

/** The contact step is done: the cart has an email and a ship-to address. */
export function cartReadyForPayment(cart: Partial<PayableCart> | undefined): boolean {
	return Boolean(cart?.customerEmail?.includes("@") && cart.shippingAddress);
}

/** Options for Stripe Elements before any PaymentIntent exists. */
export function deferredElementsOptions(cart: PayableCart): {
	mode: "payment";
	amount: number;
	currency: string;
} {
	return { mode: "payment", amount: cart.total.amount, currency: cart.currency.toLowerCase() };
}

/**
 * Reuse the last intent only while the cart is exactly as it was when the
 * intent was created: same save time, total and currency. Any change (a
 * coupon, a shipping option, a quantity) means a new intent at the new
 * total.
 */
export function canReuseIntent(last: CreatedIntent | null, cart: PayableCart): boolean {
	return Boolean(
		last?.cartUpdatedAt &&
			last.cartUpdatedAt === cart.updatedAt &&
			last.total.amount === cart.total.amount &&
			last.currency === cart.currency,
	);
}

function formatMoney(m: Money): string {
	try {
		return new Intl.NumberFormat(undefined, { style: "currency", currency: m.currency }).format(
			m.amount / 100,
		);
	} catch {
		return `${m.currency} ${(m.amount / 100).toFixed(2)}`;
	}
}

async function fetchCart(): Promise<PayableCart | null> {
	try {
		const res = await fetch(`${API}/cart`, { credentials: "include" });
		if (!res.ok) return null;
		const body = (await res.json()) as { cart?: PayableCart };
		return body.cart ?? null;
	} catch {
		return null;
	}
}

export default function CheckoutFormIsland({ publishableKey, returnUrl }: CheckoutFormIslandProps) {
	const [cart, setCart] = useState<PayableCart | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [stripeModule, setStripeModule] = useState<typeof import("@stripe/react-stripe-js") | null>(
		null,
	);
	const [stripePromise, setStripePromise] = useState<ReturnType<
		typeof import("@stripe/stripe-js").loadStripe
	> | null>(null);
	const loadingRef = useRef(false);

	const loadStripe = useCallback(async () => {
		if (loadingRef.current) return;
		loadingRef.current = true;
		try {
			const [reactStripe, stripeJs] = await Promise.all([
				import("@stripe/react-stripe-js"),
				import("@stripe/stripe-js"),
			]);
			setStripeModule(reactStripe);
			setStripePromise(stripeJs.loadStripe(publishableKey));
		} catch (err) {
			loadingRef.current = false;
			setError(err instanceof Error ? err.message : "Could not load the payment form");
		}
	}, [publishableKey]);

	// Follow the cart: show the form once the contact step is done, and
	// keep its amount in step with coupon or shipping changes.
	useEffect(() => {
		let cancelled = false;
		async function refresh() {
			const next = await fetchCart();
			if (cancelled || !next) return;
			if (!cartReadyForPayment(next)) return;
			setCart(next);
			void loadStripe();
		}
		void refresh();
		const onCartUpdated = () => {
			void refresh();
		};
		window.addEventListener("dashcommerce:cart-updated", onCartUpdated);
		return () => {
			cancelled = true;
			window.removeEventListener("dashcommerce:cart-updated", onCartUpdated);
		};
	}, [loadStripe]);

	if (error) return <div role="alert">Checkout unavailable: {error}</div>;
	if (!cart || !stripeModule || !stripePromise) return <div>Loading checkout…</div>;
	if (cart.total.amount <= 0) return <div role="alert">There's nothing to pay on this order.</div>;

	const { Elements } = stripeModule;
	return (
		<Elements stripe={stripePromise} options={deferredElementsOptions(cart)}>
			<InnerForm cart={cart} returnUrl={returnUrl} stripeModule={stripeModule} onCart={setCart} />
		</Elements>
	);
}

function InnerForm({
	cart,
	returnUrl,
	stripeModule,
	onCart,
}: {
	cart: PayableCart;
	returnUrl: string;
	stripeModule: typeof import("@stripe/react-stripe-js");
	onCart: (cart: PayableCart) => void;
}) {
	const { PaymentElement, useStripe, useElements } = stripeModule;
	const stripe = useStripe();
	const elements = useElements();
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const lastIntent = useRef<CreatedIntent | null>(null);

	// Keep the card form's amount in step with the cart.
	useEffect(() => {
		if (!elements) return;
		const { amount, currency } = deferredElementsOptions(cart);
		elements.update({ amount, currency });
	}, [elements, cart]);

	async function createIntent(): Promise<CreatedIntent | null> {
		const res = await fetch(`${API}/checkout/create-intent`, {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		const body = (await res.json().catch(() => ({}))) as Partial<CreatedIntent> & {
			error?: unknown;
			code?: string;
			cart?: PayableCart;
		};
		if (res.status === 409 && body.code === "cart_totals_changed" && body.cart) {
			// The server re-priced the cart: show the new total and let the
			// customer confirm it before paying.
			onCart(body.cart);
			window.dispatchEvent(
				new CustomEvent("dashcommerce:cart-updated", { detail: { silent: true } }),
			);
			setError(
				`Your total is now ${formatMoney(body.cart.total)}. Check your order, then press Pay again.`,
			);
			return null;
		}
		if (!res.ok || !body.clientSecret || !body.orderDraftId) {
			setError(
				typeof body.error === "string" && body.error ? body.error : "Payment couldn't start.",
			);
			return null;
		}
		return body as CreatedIntent;
	}

	async function onSubmit(e: FormEvent) {
		e.preventDefault();
		if (!stripe || !elements) return;
		setSubmitting(true);
		setError(null);
		try {
			const { error: submitError } = await elements.submit();
			if (submitError) {
				setError(submitError.message ?? "Check your payment details.");
				return;
			}
			const current = (await fetchCart()) ?? cart;
			const intent = canReuseIntent(lastIntent.current, current)
				? lastIntent.current
				: await createIntent();
			if (!intent) return;
			lastIntent.current = intent;
			const { error: confirmError } = await stripe.confirmPayment({
				elements,
				clientSecret: intent.clientSecret,
				confirmParams: { return_url: returnUrl.replace("{orderDraftId}", intent.orderDraftId) },
			});
			if (confirmError) setError(confirmError.message ?? "Payment failed");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Payment failed");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<form onSubmit={onSubmit} className="dc-checkout-form">
			<PaymentElement />
			<button type="submit" className="dc-checkout-form__submit" disabled={!stripe || submitting}>
				{submitting ? "Processing…" : `Pay ${formatMoney(cart.total)}`}
			</button>
			{error && (
				<p role="alert" className="dc-checkout-form__error">
					{error}
				</p>
			)}
			<style>{`
				.dc-checkout-form__submit {
					margin-top: 16px;
					padding: 0.75rem 1.5rem;
					background: var(--accent, var(--gold, #111));
					color: var(--accent-on, #fff);
					border: 0;
					border-radius: var(--radius, 4px);
					cursor: pointer;
					font-weight: 500;
					transition: background .2s, filter .2s;
				}
				.dc-checkout-form__submit:hover:not(:disabled) {
					background: var(--gold-light, var(--accent, #333));
					filter: brightness(1.08);
				}
				.dc-checkout-form__submit:disabled { opacity: 0.6; cursor: not-allowed; }
				.dc-checkout-form__error { color: var(--ember, #a00); }
			`}</style>
		</form>
	);
}
