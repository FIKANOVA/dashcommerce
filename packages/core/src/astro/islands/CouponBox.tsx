/**
 * Coupon entry shared by the cart page and the checkout order summary:
 * the applied codes with a Remove button each, and a form to add one.
 *
 * Calls `POST /cart/coupon` and `DELETE /cart/coupon/remove?code={code}`,
 * hands the recalculated cart to `onCart`, and sends a silent
 * `dashcommerce:cart-updated` so other cart views refresh without
 * opening the drawer.
 */

import { type FormEvent, useState } from "react";

interface Money {
	currency: string;
	amount: number;
}

export interface AppliedCoupon {
	code: string;
	discountAmount: Money;
	freeShipping: boolean;
}

const API = "/_emdash/api/plugins/dashcommerce";

function formatMoney(m: Money, locale: string) {
	try {
		return new Intl.NumberFormat(locale, {
			style: "currency",
			currency: m.currency,
		}).format(m.amount / 100);
	} catch {
		return `${m.currency} ${m.amount / 100}`;
	}
}

export interface CouponBoxProps<C> {
	coupons: AppliedCoupon[];
	/** Receives the cart returned after a code is applied or removed. */
	onCart: (cart: C) => void;
	/** Told when a request starts and ends, so the host can lock its own controls. */
	onPendingChange?: (pending: boolean) => void;
	/** Locks the box while the host has a request of its own in flight. */
	disabled?: boolean;
	/** Heading level, to fit the surrounding page outline. */
	headingLevel?: 3 | 4;
	locale?: string;
}

export default function CouponBox<C>({
	coupons,
	onCart,
	onPendingChange,
	disabled = false,
	headingLevel = 3,
	locale = "en-US",
}: CouponBoxProps<C>) {
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const locked = pending || disabled;
	const Heading = headingLevel === 4 ? "h4" : "h3";

	function setBusy(busy: boolean) {
		setPending(busy);
		onPendingChange?.(busy);
	}

	async function send(request: Promise<Response>, fallback: string): Promise<boolean> {
		setBusy(true);
		setError(null);
		try {
			const res = await request;
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: unknown };
				setError(
					typeof body.error === "string" && body.error ? body.error : `${fallback} (${res.status})`,
				);
				return false;
			}
			const body = (await res.json()) as { cart: C };
			onCart(body.cart);
			window.dispatchEvent(
				new CustomEvent("dashcommerce:cart-updated", { detail: { silent: true } }),
			);
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : "Network error");
			return false;
		} finally {
			setBusy(false);
		}
	}

	async function apply(e: FormEvent) {
		e.preventDefault();
		const code = draft.trim();
		if (!code) return;
		const ok = await send(
			fetch(`${API}/cart/coupon`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ code }),
			}),
			"Coupon rejected",
		);
		if (ok) setDraft("");
	}

	function remove(code: string) {
		void send(
			fetch(`${API}/cart/coupon/remove?code=${encodeURIComponent(code)}`, {
				method: "DELETE",
				credentials: "include",
			}),
			"Remove failed",
		);
	}

	return (
		<section className="dc-coupon">
			<Heading>Coupon</Heading>
			{coupons.length > 0 && (
				<ul className="dc-applied-coupons">
					{coupons.map((c) => (
						<li key={c.code}>
							<code>{c.code}</code>{" "}
							{c.freeShipping ? "(free shipping)" : `−${formatMoney(c.discountAmount, locale)}`}
							<button
								type="button"
								onClick={() => remove(c.code)}
								disabled={locked}
								aria-label={`Remove coupon ${c.code}`}
							>
								Remove
							</button>
						</li>
					))}
				</ul>
			)}
			<form onSubmit={apply} className="dc-coupon-form">
				<label>
					Have a code?{" "}
					<input
						type="text"
						value={draft}
						onChange={(e) => setDraft(e.currentTarget.value)}
						placeholder="SAVE10"
						disabled={locked}
					/>
				</label>
				<button type="submit" disabled={locked || !draft.trim()}>
					Apply
				</button>
			</form>
			{error && (
				<p role="alert" className="dc-coupon-error">
					{error}
				</p>
			)}
			<style>{`
				.dc-coupon { padding: 1rem 0; border-top: 1px solid var(--border-mid, #e4e4e7); margin-bottom: 1.5rem; }
				.dc-coupon h3, .dc-coupon h4 { margin: 0 0 0.5rem; font-size: 1em; color: var(--text, #111); }
				.dc-applied-coupons { list-style: none; padding: 0; margin: 0 0 0.75rem; display: flex; flex-wrap: wrap; gap: 0.5rem; }
				.dc-applied-coupons li {
					display: inline-flex; gap: 0.5rem; align-items: center;
					padding: 0.25rem 0.5rem;
					background: var(--success-bg, rgba(76, 175, 120, 0.12));
					border: 1px solid var(--success, #86efac);
					color: var(--text, #14532d);
					border-radius: 4px; font-size: 0.9em;
				}
				.dc-applied-coupons button { background: transparent; border: 0; color: var(--text-mid, #555); cursor: pointer; font-size: 0.85em; text-decoration: underline; padding: 0; }
				.dc-coupon-form { display: flex; gap: 0.5rem; align-items: end; flex-wrap: wrap; }
				.dc-coupon-form input {
					padding: 6px 10px;
					border: 1px solid var(--border-strong, #d4d4d8);
					background: var(--surface, #fff);
					color: var(--text, #111);
					border-radius: 4px;
					min-width: 0;
				}
				.dc-coupon-form button {
					padding: 6px 12px;
					background: var(--surface, #fff);
					border: 1px solid var(--border-strong, #d4d4d8);
					color: var(--text, #111);
					border-radius: 4px; cursor: pointer;
				}
				.dc-coupon-form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85em; color: var(--text-mid, #444); }
				.dc-coupon-error { color: var(--ember, #a00); margin-top: 0.5rem; font-size: 0.9em; }
			`}</style>
		</section>
	);
}
