/**
 * Provider-aware copy and error parsing utilities for Hosted Checkout.
 */

export function extractErrorMessage(body: unknown, status: number): string {
	if (typeof body === "string" && body.trim()) return body;
	if (body && typeof body === "object") {
		const b = body as Record<string, unknown>;
		if (typeof b.error === "string" && b.error.trim()) {
			return b.error;
		}
		if (b.error && typeof b.error === "object") {
			const errObj = b.error as Record<string, unknown>;
			if (typeof errObj.message === "string" && errObj.message.trim()) {
				return errObj.message;
			}
		}
		if (typeof b.message === "string" && b.message.trim()) {
			return b.message;
		}
	}
	return `Payment setup failed (${status})`;
}

export interface HostedCheckoutCopy {
	label: string;
	detailsHint: string;
	payHint: string;
	payButtonText: string;
	redirectingText: string;
}

export function getHostedCheckoutCopy(
	provider: string = "stripe",
	digitalOnly: boolean = false,
	providerLabel?: string,
): HostedCheckoutCopy {
	const normalized = (provider || "stripe").toLowerCase();
	const label =
		providerLabel ??
		(normalized === "paystack" ? "Paystack" : normalized === "stripe" ? "Stripe" : provider);

	if (normalized === "paystack") {
		return {
			label,
			detailsHint: digitalOnly
				? "Enter your email address to receive your order receipt and digital access."
				: "Enter your email and location to view available shipping options.",
			payHint:
				"You'll be redirected to Paystack to complete your payment securely. We never see your payment details.",
			payButtonText: `Pay with ${label} →`,
			redirectingText: `Redirecting to ${label}…`,
		};
	}

	if (normalized === "stripe") {
		return {
			label,
			detailsHint: digitalOnly
				? "Enter your email for your order receipt. Stripe collects billing details on the next page."
				: "Enter your email and location — we'll show available shipping options. Stripe collects your full address on the next page.",
			payHint: `You'll be redirected to Stripe to enter your ${
				digitalOnly ? "billing address and card details" : "full address and card details"
			}. We never see your card.`,
			payButtonText: `Pay with ${label} →`,
			redirectingText: `Redirecting to ${label}…`,
		};
	}

	return {
		label,
		detailsHint: digitalOnly
			? "Enter your email address for your order receipt."
			: "Enter your email and location to view available shipping options.",
		payHint: `You'll be redirected to ${label} to complete your payment securely. We never see your payment details.`,
		payButtonText: `Pay with ${label} →`,
		redirectingText: `Redirecting to ${label}…`,
	};
}
