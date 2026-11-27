/**
 * PaystackPaymentProvider — Paystack implementing @dashcommerce/core's
 * PaymentProvider interface.
 *
 * Channel note: Paystack's hosted checkout page offers whichever
 * channels are enabled on the merchant's Paystack Kenya account
 * ("card", "mobile_money" — M-Pesa STK is triggered from inside the
 * `mobile_money` channel on the hosted page).
 */

import type {
	ConnectionCheckResult,
	CreatePayoutAccountInput,
	CreateRefundInput,
	CreatedPayoutAccount,
	InitCheckoutInput,
	InitCheckoutResult,
	NormalizedPaymentEvent,
	PaymentProvider,
	PaymentProviderBank,
	PaymentProviderCredentials,
	PaymentProviderRuntimeContext,
	PaymentStatusResult,
	ProviderSubscriptionInfo,
	PaymentProviderTerminal,
	RefundResult,
	ResolvePayoutAccountInput,
	StartInPersonPaymentInput,
	StartInPersonPaymentResult,
	VerifyWebhookInput,
	VerifyWebhookResult,
} from "@dashcommerce/core/payment-provider";
import { CurrencyNotSupportedError } from "@dashcommerce/core/payment-provider";
import { PaystackApiError, type PaystackClientOptions, call, callEnvelope } from "./client";
import { PAYSTACK_LOGO } from "./logo";
import { verifyPaystackSignature } from "./webhook-verify";

const SUPPORTED_CURRENCIES = new Set(["KES", "NGN", "GHS", "ZAR", "USD"]);

const PAYSTACK_CHANNEL_MAP: Record<string, string> = {
	card: "card",
	mpesa: "mobile_money",
	"m-pesa": "mobile_money",
	mobile_money: "mobile_money",
};

/**
 * Paystack accepts only `-`, `.`, `=` and alphanumerics in a transaction
 * reference. Core's draft ids are hex, so this is normally `dc-<draftId>`;
 * anything else is replaced rather than sent and rejected.
 */
export function paystackReferenceFor(orderDraftId: string): string {
	return `${REFERENCE_PREFIX}${orderDraftId.replace(/[^A-Za-z0-9.=-]/g, "-")}`;
}

const REFERENCE_PREFIX = "dc-";

/** Recover a core draft id from a reference this provider issued. */
function draftIdFromReference(reference: string): string | undefined {
	if (!reference.startsWith(REFERENCE_PREFIX)) return undefined;
	const id = reference.slice(REFERENCE_PREFIX.length);
	return /^[0-9a-f]{32}$/.test(id) ? id : undefined;
}

/**
 * Core builds the success URL for Stripe, with a `{CHECKOUT_SESSION_ID}`
 * placeholder that Stripe fills in. Paystack does not, so drop it and let
 * Paystack append its own `trxref` and `reference` parameters.
 */
function paystackCallbackUrl(successUrl: string): string {
	const url = new URL(successUrl);
	for (const [key, value] of [...url.searchParams]) {
		if (value === "{CHECKOUT_SESSION_ID}") url.searchParams.delete(key);
	}
	return url.toString();
}

/** Paystack documents metadata as a JSON object, but tolerate a string. */
function metadataOf(raw: unknown): Record<string, unknown> | undefined {
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw) as unknown;
			return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
		} catch {
			return undefined;
		}
	}
	return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
}

function toPaystackClient(credentials: PaymentProviderCredentials): PaystackClientOptions {
	return { secretKey: credentials.secretKey };
}

function mapChannels(preferred: string[] | undefined): string[] | undefined {
	if (!preferred || preferred.length === 0) return undefined;
	const mapped = new Set<string>();
	for (const p of preferred) {
		const m = PAYSTACK_CHANNEL_MAP[p.toLowerCase()];
		if (m) mapped.add(m);
	}
	return mapped.size > 0 ? Array.from(mapped) : undefined;
}

interface PaystackInitializeData {
	authorization_url: string;
	access_code: string;
	reference: string;
}

interface PaystackWebhookEvent {
	event: string;
	data: {
		id: number;
		reference: string;
		amount?: number;
		currency?: string;
		status?: string;
		customer?: {
			id?: number;
			email?: string;
			first_name?: string;
			last_name?: string;
			phone?: string;
		};
		authorization?: { channel?: string };
		channel?: string;
		metadata?: {
			orderDraftId?: string;
			checkoutReference?: string;
			billingAddress?: unknown;
			shippingAddress?: unknown;
			[key: string]: unknown;
		};
		gateway_response?: string;
		/**
		 * The plan this charge belongs to. An object with `plan_code` on a
		 * subscription charge; an empty object on other charges.
		 */
		plan?: unknown;
		/** Present when the payment was split: what each party was paid. */
		split?: {
			shares?: {
				paystack?: number;
				integration?: number;
				subaccounts?: Array<{ amount?: number; subaccount_code?: string }>;
			};
		};
	};
}

interface PaystackVerifyData {
	id: number;
	reference: string;
	amount: number;
	currency: string;
	status: string;
	gateway_response?: string;
	channel?: string;
	/** A plan code, or a plan object, when the charge belongs to a plan. */
	plan?: unknown;
	plan_object?: unknown;
}

interface PaystackRefundData {
	id: number;
	status: string;
	amount: number;
	currency: string;
	merchant_note?: string | null;
	createdAt?: string;
}

interface PaystackRefundPage {
	data: PaystackRefundData[];
	pageCount: number;
}

/**
 * Transaction statuses from https://paystack.com/docs/payments/verify-payments/,
 * plus `reversal-pending`, which the docs omit but /transaction/verify returns
 * once a refund has started (seen on the test account, 19 Nov 2026).
 * A reversed transaction was paid: Paystack reports `reversed` and
 * `reversal-pending` after partial refunds too, and those refunds are tracked
 * on their own. `getPaymentStatus` refuses only one that has been refunded in
 * full, so a late webhook retry cannot create an order for money already
 * returned.
 * `abandoned` is not final: the customer may still complete the payment.
 */
const TRANSACTION_STATUS: Record<string, "pending" | "succeeded" | "failed"> = {
	success: "succeeded",
	reversed: "succeeded",
	"reversal-pending": "succeeded",
	failed: "failed",
	abandoned: "pending",
	ongoing: "pending",
	pending: "pending",
	processing: "pending",
	queued: "pending",
};

/** Refund statuses from https://paystack.com/docs/payments/refunds/. */
const REFUND_STATUS: Record<string, RefundResult["status"]> = {
	pending: "pending",
	processing: "pending",
	"needs-attention": "pending",
	processed: "succeeded",
	failed: "failed",
};

/**
 * Paystack keeps no idempotency key for refunds, and assigns its own refund
 * reference. `merchant_note` is the only field that keeps ours, so the request
 * id goes there in a form that can be read back exactly.
 */
const REFUND_REQUEST_ID = /^[^\s()]+$/;
// Anchored at the end, so text in `reason` cannot pose as the tag.
const NOTE_REQUEST_ID = /\(refundRequestId=([^\s()]+)\)\s*$/;

function merchantNoteFor(refundRequestId: string, reason?: string): string {
	const tag = `(refundRequestId=${refundRequestId})`;
	const text = reason?.replace(/[()]/g, "").trim();
	return text ? `${text} ${tag}` : tag;
}

const REVERSED = new Set(["reversed", "reversal-pending"]);

const REFUND_PAGE_SIZE = 100;
const MAX_REFUND_PAGES = 20;

/**
 * Find a refund on this transaction already made for `refundRequestId`.
 * Refunds are listed by the numeric transaction id: filtering by reference
 * silently returns nothing. A failed refund does not count, so it can be
 * retried. The earliest match wins.
 */
async function findRefundForRequest(
	ctx: PaymentProviderRuntimeContext,
	client: PaystackClientOptions,
	transactionRef: string,
	refundRequestId: string,
): Promise<PaystackRefundData | undefined> {
	const transaction = await call<PaystackVerifyData>(ctx, {
		client,
		method: "GET",
		path: `/transaction/verify/${encodeURIComponent(transactionRef)}`,
	});
	if (!Number.isSafeInteger(transaction.id)) {
		throw new Error("Paystack verify returned no numeric transaction id; refusing to refund blind");
	}

	const matches: PaystackRefundData[] = [];
	for (let page = 1, pageCount = 1; page <= pageCount; page += 1) {
		if (page > MAX_REFUND_PAGES) {
			throw new Error(
				`Paystack lists more than ${MAX_REFUND_PAGES} pages of refunds for one transaction`,
			);
		}
		const result = await listRefundPage(ctx, client, transaction.id, page);
		for (const refund of result.data) {
			const tagged = NOTE_REQUEST_ID.exec(refund.merchant_note ?? "")?.[1];
			if (tagged === refundRequestId && refund.status !== "failed") matches.push(refund);
		}
		pageCount = result.pageCount;
	}

	matches.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id - b.id);
	return matches[0];
}

/** Sum of a transaction's refunds that have not failed, in minor units. */
async function refundedTotal(
	ctx: PaymentProviderRuntimeContext,
	client: PaystackClientOptions,
	transactionId: number,
): Promise<number> {
	let total = 0;
	for (let page = 1, pageCount = 1; page <= pageCount; page += 1) {
		if (page > MAX_REFUND_PAGES) {
			throw new Error(
				`Paystack lists more than ${MAX_REFUND_PAGES} pages of refunds for one transaction`,
			);
		}
		const result = await listRefundPage(ctx, client, transactionId, page);
		for (const refund of result.data) {
			if (refund.status !== "failed" && typeof refund.amount === "number") total += refund.amount;
		}
		pageCount = result.pageCount;
	}
	return total;
}

async function listRefundPage(
	ctx: PaymentProviderRuntimeContext,
	client: PaystackClientOptions,
	transactionId: number,
	page: number,
): Promise<PaystackRefundPage> {
	const query = new URLSearchParams({
		transaction: String(transactionId),
		perPage: String(REFUND_PAGE_SIZE),
		page: String(page),
	});
	const result = await callEnvelope<PaystackRefundData[]>(ctx, {
		client,
		method: "GET",
		path: `/refund?${query}`,
	});
	if (!Array.isArray(result.data)) {
		throw new Error("Paystack refund list returned no data array");
	}
	const pageCount = result.meta?.pageCount;
	return {
		data: result.data,
		pageCount: typeof pageCount === "number" ? pageCount : 1,
	};
}

const SECRET_KEY = /^sk_(test|live)_/;

/**
 * Pick the header and the secret to verify it with. `Paystack-Signature` is
 * keyed with the `whsec_` signing secret; `x-paystack-signature` with the
 * `sk_` secret key, which may be saved as the webhook secret or as the API
 * key. Paystack can send either or both: a real test-mode run delivered only
 * `x-paystack-signature` on an account that had a `whsec_` secret.
 *
 * When `Paystack-Signature` is present and a `whsec_` secret is saved, it
 * decides alone, so a replay outside its 300-second window cannot pass on
 * the window-less legacy header sent alongside it.
 */
function signatureToVerify(input: VerifyWebhookInput): { header: string; secret: string } {
	const current = input.headers?.get("paystack-signature") ?? null;
	const legacy = input.headers?.get("x-paystack-signature") ?? null;
	const saved = [input.secret, input.credentials?.webhookSecret, input.credentials?.secretKey];
	const whsec = saved.find((s) => s?.startsWith("whsec_"));
	const skKey = saved.find((s) => s !== undefined && SECRET_KEY.test(s));

	if (current && whsec) return { header: current, secret: whsec };
	if (legacy && skKey) return { header: legacy, secret: skKey };
	// Nothing pairs up: verify what core routed on with the webhook secret,
	// which gives the merchant the precise reason it fails.
	return { header: input.signatureHeader, secret: input.secret };
}

interface PaystackRefundWebhookData {
	id?: number | string;
	status?: string;
	transaction_reference?: string;
	refund_reference?: string;
}

/** Refund webhooks, from https://paystack.com/docs/payments/refunds/. */
const REFUND_EVENT_STATUS: Record<string, "pending" | "succeeded" | "failed"> = {
	"refund.pending": "pending",
	"refund.processing": "pending",
	"refund.needs-attention": "pending",
	"refund.processed": "succeeded",
	"refund.failed": "failed",
};

/**
 * Report a refund's new status by the numeric refund id that `refund()`
 * returned. Paystack's documented sample shows only `refund_reference`, but
 * real deliveries carry `id` (a string such as "19244346") with a null
 * `refund_reference`. Without an id the event is left unhandled rather than
 * matched by guesswork.
 */
function refundEvent(
	eventName: string,
	data: PaystackRefundWebhookData | undefined,
	raw: unknown,
): NormalizedPaymentEvent {
	const status = REFUND_EVENT_STATUS[eventName];
	const id = data?.id;
	if (!status || (typeof id !== "number" && typeof id !== "string") || String(id) === "") {
		return { type: "unhandled", providerEventType: eventName, raw };
	}
	return {
		type: "refund.updated",
		providerId: "paystack",
		// Paystack sends no event id, so the event name plus the refund id
		// stands in for one. Core records it before the handler runs, so a
		// repeat or overlapping delivery of the same status is skipped instead
		// of reversing a failed refund twice. Each status keeps its own id, so
		// `refund.pending` never blocks the later `refund.failed`.
		providerEventId: `${eventName}:${String(id)}`,
		providerRefundId: String(id),
		status,
		...(data?.transaction_reference ? { paymentReference: data.transaction_reference } : {}),
		raw,
	};
}

/**
 * Dispute webhooks. Paystack's docs name the events but do not show the
 * payload, so it is read defensively from the Dispute object's fields and
 * anything missing leaves the event unhandled rather than guessed.
 */
interface PaystackDisputeWebhookData {
	id?: number | string;
	status?: string;
	resolution?: string | null;
	refund_amount?: number | null;
	currency?: string;
	dueAt?: string | null;
	due_at?: string | null;
	category?: string;
	transaction?: { reference?: string; amount?: number; currency?: string };
}

const DISPUTE_EVENTS = new Set([
	"charge.dispute.create",
	"charge.dispute.remind",
	"charge.dispute.resolve",
]);

/** `merchant-accepted` means the customer is refunded; `declined` means the shop keeps it. */
const DISPUTE_RESOLUTION: Record<string, "won" | "lost"> = {
	"merchant-accepted": "lost",
	declined: "won",
};

function disputeEvent(
	eventName: string,
	data: PaystackDisputeWebhookData | undefined,
	raw: unknown,
): NormalizedPaymentEvent {
	const unhandled: NormalizedPaymentEvent = {
		type: "unhandled",
		providerEventType: eventName,
		raw,
	};
	const id = data?.id;
	const reference = data?.transaction?.reference;
	if ((typeof id !== "number" && typeof id !== "string") || String(id) === "" || !reference) {
		return unhandled;
	}
	let status: "open" | "won" | "lost";
	if (data?.resolution) {
		const resolved = DISPUTE_RESOLUTION[data.resolution];
		if (!resolved) return unhandled;
		status = resolved;
	} else if (eventName === "charge.dispute.resolve" || data?.status === "resolved") {
		return unhandled;
	} else {
		status = "open";
	}
	const amount =
		typeof data?.refund_amount === "number" && data.refund_amount > 0
			? data.refund_amount
			: data?.transaction?.amount;
	const currency = data?.currency ?? data?.transaction?.currency;
	if (typeof amount !== "number" || !currency) return unhandled;
	const dueAt = data?.dueAt ?? data?.due_at;
	const due = dueAt ? new Date(dueAt) : undefined;
	return {
		type: "dispute.updated",
		providerId: "paystack",
		// No event id from Paystack: the event name plus dispute id stands in,
		// as for refunds.
		providerEventId: `${eventName}:${String(id)}`,
		providerDisputeId: String(id),
		paymentReference: reference,
		status,
		amount,
		currency: currency.toUpperCase(),
		...(data?.category ? { reason: data.category } : {}),
		...(due && !Number.isNaN(due.getTime()) ? { dueAt: due.toISOString() } : {}),
		raw,
	};
}

/**
 * Core's allocations are exact minor-unit shares, so they become a flat
 * split passed with this one payment: each vendor's subaccount gets its
 * share, and the shop keeps the rest and pays Paystack's fee
 * (`bearer_type: "account"`), as with Stripe Connect. Validated first: a
 * bad share must fail checkout rather than settle everything to the shop.
 */
function splitFor(input: InitCheckoutInput):
	| {
			type: "flat";
			bearer_type: "account";
			subaccounts: Array<{ subaccount: string; share: number }>;
	  }
	| undefined {
	if (!input.allocations || input.allocations.length === 0) return undefined;
	let total = 0;
	const subaccounts = input.allocations.map((allocation) => {
		const subaccount = allocation.accountReference?.trim();
		if (!subaccount) {
			throw new Error(`Vendor ${allocation.vendorId} has no Paystack subaccount code`);
		}
		if (!Number.isSafeInteger(allocation.amountMinor) || allocation.amountMinor <= 0) {
			throw new Error(
				`Vendor ${allocation.vendorId}'s split amount must be a positive integer in minor units`,
			);
		}
		total += allocation.amountMinor;
		if (!Number.isSafeInteger(total)) {
			throw new Error("Split allocations exceed the safe integer range");
		}
		return { subaccount, share: allocation.amountMinor };
	});
	if (total > input.amount) {
		throw new Error(`Split allocations (${total}) exceed the checkout amount (${input.amount})`);
	}
	return { type: "flat", bearer_type: "account", subaccounts };
}

/** What each party was paid, from `charge.success` `split.shares`. */
function splitSettlementFrom(
	split: PaystackWebhookEvent["data"]["split"],
	currency: string,
):
	| {
			allocations: Array<{ accountReference: string; amountMinor: number }>;
			platformRemainderMinor?: number;
			providerFeeMinor?: number;
			currency: string;
			raw: unknown;
	  }
	| undefined {
	const shares = split?.shares;
	if (!shares || !Array.isArray(shares.subaccounts)) return undefined;
	const allocations = shares.subaccounts
		.filter(
			(s): s is { amount: number; subaccount_code: string } =>
				typeof s?.subaccount_code === "string" &&
				s.subaccount_code !== "" &&
				Number.isSafeInteger(s.amount),
		)
		.map((s) => ({ accountReference: s.subaccount_code, amountMinor: s.amount }));
	if (allocations.length === 0) return undefined;
	return {
		allocations,
		...(Number.isSafeInteger(shares.integration)
			? { platformRemainderMinor: shares.integration as number }
			: {}),
		...(Number.isSafeInteger(shares.paystack)
			? { providerFeeMinor: shares.paystack as number }
			: {}),
		currency,
		raw: split,
	};
}

interface PaystackBankRow {
	code?: string;
	name?: string;
	active?: boolean;
}

interface PaystackBankPage {
	data: PaystackBankRow[];
	meta?: Record<string, unknown>;
}

/** Paystack's `country` filter for the bank list, by ISO-2 code. */
const PAYSTACK_COUNTRY: Record<string, string> = {
	GH: "ghana",
	KE: "kenya",
	NG: "nigeria",
	ZA: "south africa",
};

/** Each payout country's own currency, for the mobile-money list. */
const COUNTRY_CURRENCY: Record<string, string> = { GH: "GHS", KE: "KES", NG: "NGN", ZA: "ZAR" };

/** The country a Paystack account is in, from its balance currencies. */
const CURRENCY_COUNTRY: Record<string, string> = { GHS: "GH", KES: "KE", NGN: "NG", ZAR: "ZA" };

/**
 * Countries this Paystack account can pay vendors in. Subaccounts must be in
 * the account's own country, so a Kenyan shop pays Kenyan banks and mobile
 * money only. Worked out from the account's balance currencies (USD is
 * ignored; Kenyan and Nigerian accounts can hold it too). Returns `null`
 * when the key may not read the balance (a restricted key, say), and the
 * caller then doesn't restrict: Paystack still refuses a wrong-country
 * subaccount itself.
 */
async function accountPayoutCountries(
	ctx: PaymentProviderRuntimeContext,
	credentials: PaymentProviderCredentials,
): Promise<string[] | null> {
	try {
		const balances = await call<Array<{ currency?: string }>>(ctx, {
			client: toPaystackClient(credentials),
			method: "GET",
			path: "/balance",
		});
		const countries = new Set<string>();
		for (const row of Array.isArray(balances) ? balances : []) {
			const country = CURRENCY_COUNTRY[row?.currency?.toUpperCase() ?? ""];
			if (country) countries.add(country);
		}
		return countries.size > 0 ? Array.from(countries) : null;
	} catch {
		return null;
	}
}

const COUNTRY_NAME: Record<string, string> = {
	GH: "Ghana",
	KE: "Kenya",
	NG: "Nigeria",
	ZA: "South Africa",
};

async function assertPayoutCountry(
	ctx: PaymentProviderRuntimeContext,
	iso: string,
	credentials: PaymentProviderCredentials,
): Promise<void> {
	const allowed = await accountPayoutCountries(ctx, credentials);
	if (allowed && !allowed.includes(iso)) {
		const names = allowed.map((c) => COUNTRY_NAME[c] ?? c).join(", ");
		throw new Error(
			`This Paystack account pays vendors in ${names} only. Choose ${allowed.join(" or ")} as the vendor's country.`,
		);
	}
}

function lastFour(accountNumber: string): string {
	return `****${accountNumber.slice(-4)}`;
}

// ── Subscriptions ─────────────────────────────────────────────────────────
//
// One Paystack plan per subscription: checkout creates a plan for the cart
// and initialises the first payment with it. Paystack then charges each
// renewal itself. The plan code is the provider subscription id core keeps.

type CoreInterval = "day" | "week" | "month" | "year";

/** Paystack's fixed plan intervals, by core interval and count. */
const PLAN_INTERVALS: Array<{ interval: CoreInterval; count: number; paystack: string }> = [
	{ interval: "day", count: 1, paystack: "daily" },
	{ interval: "week", count: 1, paystack: "weekly" },
	{ interval: "month", count: 1, paystack: "monthly" },
	{ interval: "month", count: 3, paystack: "quarterly" },
	{ interval: "month", count: 6, paystack: "biannually" },
	{ interval: "year", count: 1, paystack: "annually" },
];

function paystackIntervalFor(interval: CoreInterval, count: number): string | undefined {
	return PLAN_INTERVALS.find((row) => row.interval === interval && row.count === count)?.paystack;
}

function coreIntervalFor(
	paystack: unknown,
): { interval: CoreInterval; intervalCount: number } | undefined {
	const row = PLAN_INTERVALS.find((r) => r.paystack === paystack);
	return row ? { interval: row.interval, intervalCount: row.count } : undefined;
}

/**
 * The plan for a subscription checkout, or a clear refusal before Paystack is
 * called: one subscription line, no free trial, and an interval Paystack has.
 */
function planFor(input: InitCheckoutInput): { name: string; interval: string } {
	const recurring = input.lineItems.filter((line) => line.recurring);
	const line = recurring[0];
	if (!line?.recurring || recurring.length > 1) {
		throw new Error(
			"Paystack takes one subscription per order. Check out each subscription on its own.",
		);
	}
	if ((input.subscriptionTrialPeriodDays ?? 0) > 0) {
		throw new Error(
			"Paystack subscriptions can't start with a free trial. Remove the trial to sell this product with Paystack.",
		);
	}
	if (input.allocations && input.allocations.length > 0) {
		throw new Error("Paystack subscriptions can't be split between vendors.");
	}
	const { interval, intervalCount } = line.recurring;
	const paystack = paystackIntervalFor(interval, intervalCount);
	if (!paystack) {
		const every = intervalCount === 1 ? `every ${interval}` : `every ${intervalCount} ${interval}s`;
		throw new Error(
			`Paystack can't bill ${every}. Choose daily, weekly, monthly, every 3 or 6 months, or yearly.`,
		);
	}
	return { name: line.name, interval: paystack };
}

/** A plan code from a charge or verify payload: an object with `plan_code`, or the code itself. */
function planCodeOf(...candidates: unknown[]): string | undefined {
	for (const plan of candidates) {
		if (typeof plan === "string" && plan.startsWith("PLN_")) return plan;
		if (plan && typeof plan === "object") {
			const code = (plan as { plan_code?: unknown }).plan_code;
			if (typeof code === "string" && code !== "") return code;
		}
	}
	return undefined;
}

/** Paystack subscription statuses, from https://paystack.com/docs/payments/subscriptions/. */
function subscriptionStatusOf(status: unknown): {
	status: ProviderSubscriptionInfo["status"];
	cancelAtPeriodEnd?: boolean;
} {
	switch (status) {
		case "active":
			return { status: "active", cancelAtPeriodEnd: false };
		case "non-renewing":
			return { status: "active", cancelAtPeriodEnd: true };
		case "attention":
			return { status: "past_due" };
		case "completed":
		case "cancelled":
			return { status: "canceled" };
		default:
			return { status: "incomplete" };
	}
}

function isoDate(value: unknown): string | undefined {
	if (typeof value !== "string" || value === "") return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

interface PaystackSubscriptionRow {
	subscription_code?: string;
	email_token?: string;
	status?: string;
	amount?: number;
	next_payment_date?: string | null;
	createdAt?: string;
	plan?: { plan_code?: string; interval?: string; currency?: string } | number;
}

/**
 * The Paystack subscription on a plan. Paystack filters subscriptions by the
 * plan's numeric id, so the code is looked up first. DashCommerce creates one
 * plan per subscription; if Paystack lists more than one, the newest wins.
 */
async function subscriptionForPlan(
	ctx: PaymentProviderRuntimeContext,
	client: PaystackClientOptions,
	planCode: string,
): Promise<PaystackSubscriptionRow & { subscription_code: string; email_token: string }> {
	const plan = await call<{ id?: number }>(ctx, {
		client,
		method: "GET",
		path: `/plan/${encodeURIComponent(planCode)}`,
	});
	if (!Number.isSafeInteger(plan?.id)) {
		throw new Error(`Paystack returned no id for plan ${planCode}`);
	}
	const rows = await call<PaystackSubscriptionRow[]>(ctx, {
		client,
		method: "GET",
		path: `/subscription?plan=${encodeURIComponent(String(plan.id))}`,
	});
	const usable = (Array.isArray(rows) ? rows : [])
		.filter(
			(row): row is PaystackSubscriptionRow & { subscription_code: string; email_token: string } =>
				typeof row?.subscription_code === "string" &&
				row.subscription_code !== "" &&
				typeof row.email_token === "string" &&
				row.email_token !== "",
		)
		.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
	const row = usable[0];
	if (!row) throw new Error(`Paystack has no subscription on plan ${planCode}`);
	return row;
}

function subscriptionInfo(
	planCode: string,
	row: PaystackSubscriptionRow,
): ProviderSubscriptionInfo {
	const plan = typeof row.plan === "object" ? row.plan : undefined;
	const interval = coreIntervalFor(plan?.interval);
	const nextPayment = isoDate(row.next_payment_date);
	return {
		providerSubscriptionId: planCode,
		...subscriptionStatusOf(row.status),
		...(nextPayment ? { currentPeriodEnd: nextPayment } : {}),
		...(typeof row.amount === "number" ? { amount: row.amount } : {}),
		...(plan?.currency ? { currency: plan.currency.toUpperCase() } : {}),
		...(interval ?? {}),
	};
}

/** What a plan charge says about its subscription. Core works out the period. */
function chargeSubscription(
	planCode: string,
	charge: { amount?: number; currency?: string; plan?: unknown },
): ProviderSubscriptionInfo {
	const interval =
		charge.plan && typeof charge.plan === "object"
			? coreIntervalFor((charge.plan as { interval?: unknown }).interval)
			: undefined;
	return {
		providerSubscriptionId: planCode,
		status: "active",
		...(typeof charge.amount === "number" ? { amount: charge.amount } : {}),
		...(charge.currency ? { currency: charge.currency.toUpperCase() } : {}),
		...(interval ?? {}),
	};
}

/** Subscription and invoice webhooks that change a subscription's state. */
const SUBSCRIPTION_EVENT_STATUS: Record<
	string,
	{ status: ProviderSubscriptionInfo["status"]; cancelAtPeriodEnd?: boolean }
> = {
	"subscription.create": { status: "active" },
	"subscription.disable": { status: "canceled" },
	"subscription.not_renew": { status: "active", cancelAtPeriodEnd: true },
	"invoice.payment_failed": { status: "past_due" },
};

interface PaystackSubscriptionWebhookData {
	subscription_code?: string;
	invoice_code?: string;
	plan?: unknown;
	subscription?: { subscription_code?: string; plan?: unknown };
}

/**
 * A subscription's new state, keyed by its plan code. Subscription events
 * carry `data.plan`; invoice events carry `data.subscription`, and the plan
 * is read from either. Without a plan code or a subscription code the event
 * is left unhandled rather than matched by guesswork.
 */
function subscriptionEvent(
	eventName: string,
	data: PaystackSubscriptionWebhookData | undefined,
	raw: unknown,
): NormalizedPaymentEvent {
	const mapped = SUBSCRIPTION_EVENT_STATUS[eventName];
	const planCode = planCodeOf(data?.plan, data?.subscription?.plan);
	const subscriptionCode = data?.subscription_code ?? data?.subscription?.subscription_code;
	if (!mapped || !planCode || typeof subscriptionCode !== "string" || subscriptionCode === "") {
		return { type: "unhandled", providerEventType: eventName, raw };
	}
	const invoice =
		typeof data?.invoice_code === "string" && data.invoice_code ? `:${data.invoice_code}` : "";
	return {
		type: "subscription.updated",
		providerId: "paystack",
		// Paystack sends no event id; the event, subscription and invoice stand in.
		providerEventId: `${eventName}:${subscriptionCode}${invoice}`,
		providerSubscriptionId: planCode,
		status: mapped.status,
		...(mapped.cancelAtPeriodEnd !== undefined
			? { cancelAtPeriodEnd: mapped.cancelAtPeriodEnd }
			: {}),
		raw,
	};
}

// ────────────────────────────────────────────────────────────────────────────
// In-person (counter) payments
// ────────────────────────────────────────────────────────────────────────────

/**
 * Charge API `mobile_money.provider` for a phone prompt, by currency. Only
 * M-PESA for now: Ghana's networks each need their own code, which the
 * counter page does not ask for yet.
 */
const PHONE_PROVIDER: Record<string, string> = { KES: "mpesa" };

/** Paystack's payment requests (and so terminals) take these currencies only. */
const TERMINAL_CURRENCIES = new Set(["NGN", "GHS", "ZAR", "USD"]);

/** Payment request codes; a counter terminal sale's payment reference. */
const PAYMENT_REQUEST_PREFIX = "PRQ_";

/** Paystack asks for M-PESA numbers with the country code: +2547…, +2541…. */
export function paystackPhone(phone: string, currency: string): string {
	const digits = phone.replace(/[^\d+]/g, "");
	if (currency === "KES") {
		if (/^0[17]\d{8}$/.test(digits)) return `+254${digits.slice(1)}`;
		if (/^254[17]\d{8}$/.test(digits)) return `+${digits}`;
	}
	return digits;
}

/** Charge statuses from https://paystack.com/docs/api/charge. */
function chargeStatus(status: string | undefined): StartInPersonPaymentResult["status"] {
	if (status === "success") return "succeeded";
	if (status === "failed") return "failed";
	return "pending";
}

interface PaystackChargeData {
	reference?: string;
	status?: string;
	display_text?: string;
	message?: string;
	gateway_response?: string;
}

interface PaystackPaymentRequestData {
	id: number;
	request_code: string;
	offline_reference?: string;
	status?: string;
	paid?: boolean;
	amount?: number;
	currency?: string;
}

interface PaystackTerminalRow {
	terminal_id?: string;
	name?: string | null;
	serial_number?: string | null;
}

async function startPhonePayment(
	ctx: PaymentProviderRuntimeContext,
	input: StartInPersonPaymentInput & { method: { type: "phone"; phone: string } },
	client: PaystackClientOptions,
	currency: string,
): Promise<StartInPersonPaymentResult> {
	const provider = PHONE_PROVIDER[currency];
	if (!provider) {
		throw new Error("Paystack phone prompts are for M-PESA in Kenya (KES) only for now");
	}
	const reference = paystackReferenceFor(input.orderDraftId);
	const data = await call<PaystackChargeData>(ctx, {
		client,
		path: "/charge",
		body: {
			email: input.customer.email,
			amount: input.amount,
			currency,
			reference,
			metadata: { orderDraftId: input.orderDraftId, channel: "in_person" },
			mobile_money: { phone: paystackPhone(input.method.phone, currency), provider },
		},
	});
	const status = chargeStatus(data.status);
	const reason = data.message ?? data.gateway_response;
	return {
		// The webhook and /transaction/verify use the same reference.
		paymentReference: data.reference ?? reference,
		status,
		...(status === "failed" && reason ? { reason } : {}),
	};
}

/**
 * A payment request (invoice) pushed to the terminal. Paystack's
 * `paymentrequest.success` webhook, or the counter page's status check
 * through /paymentrequest/verify, confirms it, whichever comes first.
 */
async function startTerminalPayment(
	ctx: PaymentProviderRuntimeContext,
	input: StartInPersonPaymentInput & { method: { type: "terminal"; terminalId: string } },
	client: PaystackClientOptions,
	currency: string,
): Promise<StartInPersonPaymentResult> {
	if (!TERMINAL_CURRENCIES.has(currency)) throw new CurrencyNotSupportedError(currency);
	const customer = await call<{ customer_code?: string }>(ctx, {
		client,
		path: "/customer",
		body: { email: input.customer.email, ...(input.customer.phone ? { phone: input.customer.phone } : {}) },
	});
	if (!customer.customer_code) throw new Error("Paystack returned no customer code");
	const request = await call<PaystackPaymentRequestData>(ctx, {
		client,
		path: "/paymentrequest",
		body: {
			customer: customer.customer_code,
			amount: input.amount,
			currency,
			description: `Counter sale, order draft ${input.orderDraftId}`,
			send_notification: false,
			// Paystack takes payment request metadata as a JSON string.
			metadata: JSON.stringify({ orderDraftId: input.orderDraftId, channel: "in_person" }),
		},
	});
	if (!request.request_code || !request.offline_reference) {
		throw new Error("Paystack returned no payment request to send to the terminal");
	}
	await call(ctx, {
		client,
		path: `/terminal/${encodeURIComponent(input.method.terminalId)}/event`,
		body: {
			type: "invoice",
			action: "process",
			data: { id: request.id, reference: request.offline_reference },
		},
	});
	return { paymentReference: request.request_code, status: "pending" };
}

/**
 * `paymentrequest.success`: a counter sale paid on a terminal. Paystack's
 * docs say only that it "contains the invoice details", the same object the
 * Payment Request API returns, so every field is read defensively: the draft
 * from `metadata.orderDraftId` (sent as a JSON string, read either way), or
 * from the description this package writes; the amount as a number or a
 * numeric string. Core confirms it through /paymentrequest/verify before
 * creating the order, so the amount and currency come from Paystack's record.
 */
function paymentRequestSuccessEvent(data: unknown, raw: unknown): NormalizedPaymentEvent {
	const unhandled: NormalizedPaymentEvent = {
		type: "unhandled",
		providerEventType: "paymentrequest.success",
		raw,
	};
	if (!data || typeof data !== "object") return unhandled;
	const d = data as Record<string, unknown>;
	const code = typeof d.request_code === "string" ? d.request_code.trim() : "";
	if (!code.startsWith(PAYMENT_REQUEST_PREFIX)) return unhandled;
	const metaDraft = metadataOf(d.metadata)?.orderDraftId;
	const described =
		typeof d.description === "string" ? /order draft ([0-9a-f]{32})\b/.exec(d.description)?.[1] : undefined;
	const orderDraftId =
		typeof metaDraft === "string" && /^[0-9a-f]{32}$/.test(metaDraft) ? metaDraft : described;
	const amount =
		typeof d.amount === "number"
			? d.amount
			: typeof d.amount === "string" && /^\d+$/.test(d.amount)
				? Number(d.amount)
				: undefined;
	const currency = typeof d.currency === "string" ? d.currency.trim().toUpperCase() : "";
	if (!orderDraftId || amount === undefined || !currency) return unhandled;
	const customer = d.customer && typeof d.customer === "object" ? (d.customer as Record<string, unknown>) : {};
	return {
		type: "charge.succeeded",
		orderDraftId,
		providerId: "paystack",
		providerEventId: `paymentrequest.success:${code}`,
		checkoutReference: code,
		paymentReference: code,
		amount,
		currency,
		customer: { email: typeof customer.email === "string" ? customer.email : "" },
		channel: "Terminal",
		raw,
	};
}

async function paymentRequestStatus(
	ctx: PaymentProviderRuntimeContext,
	client: PaystackClientOptions,
	requestCode: string,
): Promise<PaymentStatusResult> {
	const data = await call<PaystackPaymentRequestData>(ctx, {
		client,
		method: "GET",
		path: `/paymentrequest/verify/${encodeURIComponent(requestCode)}`,
	});
	const status =
		data.paid === true || data.status === "success"
			? "succeeded"
			: data.status === "cancelled" || data.status === "failed"
				? "failed"
				: "pending";
	return {
		status,
		paymentReference: requestCode,
		...(typeof data.amount === "number" ? { amount: data.amount } : {}),
		...(data.currency ? { currency: data.currency.toUpperCase() } : {}),
		...(status === "failed" ? { reason: `Payment request ${data.status}` } : {}),
	};
}

export const paystackPaymentProvider: PaymentProvider = {
	id: "paystack",
	label: "Paystack",
	capabilities: {
		// Core works out the discount and sends Paystack the cart total after
		// it, so Paystack charges the right amount without its own coupons.
		coupons: true,
		connect: false,
		subscriptions: true,
		splits: true,
	},

	logo: PAYSTACK_LOGO,
	description: "Card and M-Pesa payments for African shoppers, settled in your local currency.",
	// Hosted page, or the Popup over the store's checkout (./checkout-client).
	checkoutStyles: ["hosted", "on_page"],

	// Counter sales: an M-PESA prompt on the customer's phone, or a card
	// terminal (core offers terminals only when listTerminals returns some).
	inPersonMethods: ["phone", "terminal"],

	// Current scheme first; see ./webhook-verify for both.
	webhookHeaders: ["paystack-signature", "x-paystack-signature"],

	credentialFields: {
		secretKey: {
			label: "Paystack secret or restricted key",
			prefixes: ["sk_test_", "sk_live_", "rk_test_", "rk_live_"],
			help: "Best: a restricted key with transactions:write and disputes_refunds:write only.",
		},
		webhookSecret: {
			label: "Paystack webhook signing secret",
			prefixes: ["whsec_", "sk_test_", "sk_live_"],
			help: "The whsec_ signing secret from Developers → API configuration, or your sk_ secret key. Webhooks Paystack signs with the secret key are checked with the sk_ key from either field.",
		},
	},

	supportsCurrency(currency: string): boolean {
		if (!currency || typeof currency !== "string") return false;
		return SUPPORTED_CURRENCIES.has(currency.trim().toUpperCase());
	},

	async initCheckout(
		ctx: PaymentProviderRuntimeContext,
		input: InitCheckoutInput,
		credentials: PaymentProviderCredentials,
	): Promise<InitCheckoutResult> {
		const email = input.customer.email?.trim();
		if (!email) {
			throw new Error("Paystack requires customer email to initialize checkout");
		}
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			throw new Error("Paystack requires a valid customer email to initialize checkout");
		}

		const currency = input.currency.trim().toUpperCase();
		if (!SUPPORTED_CURRENCIES.has(currency)) {
			throw new CurrencyNotSupportedError(currency);
		}
		// Checked before anything is sent, so a refusal creates nothing at Paystack.
		const plan = input.mode === "subscription" ? planFor(input) : undefined;

		const client = toPaystackClient(credentials);
		const channels = mapChannels(input.preferredChannels);
		const split = splitFor(input);
		const checkoutRef = paystackReferenceFor(input.orderDraftId);

		let data: PaystackInitializeData;
		try {
			// One plan per subscription, for the cart total, so each renewal
			// charges what the customer paid at checkout.
			const planCode = plan
				? (
						await call<{ plan_code?: string }>(ctx, {
							client,
							path: "/plan",
							body: {
								name: plan.name,
								amount: input.amount,
								interval: plan.interval,
								currency,
								description: `DashCommerce subscription, order draft ${input.orderDraftId}`,
							},
						})
					).plan_code
				: undefined;
			if (plan && !planCode) throw new Error("Paystack returned no plan code");
			data = await call<PaystackInitializeData>(ctx, {
				client,
				path: "/transaction/initialize",
				body: {
					email,
					amount: input.amount,
					currency,
					reference: checkoutRef,
					callback_url: paystackCallbackUrl(input.successUrl),
					metadata: {
						...input.metadata,
						orderDraftId: input.orderDraftId,
					},
					...(channels ? { channels } : {}),
					...(split ? { split } : {}),
					...(planCode ? { plan: planCode } : {}),
				},
			});
		} catch (err) {
			// An account not enabled for the currency (Paystack answers 403
			// `unsupported_currency`). Core turns this into a clear message.
			if (err instanceof PaystackApiError && err.body.code === "unsupported_currency") {
				throw new CurrencyNotSupportedError(currency);
			}
			throw err;
		}

		if (input.checkoutStyle === "on_page") {
			return {
				kind: "on_page",
				checkoutReference: data.reference,
				client: { accessCode: data.access_code },
			};
		}
		return {
			kind: "redirect",
			redirectUrl: data.authorization_url,
			checkoutReference: data.reference,
		};
	},

	async verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
		const { header, secret } = signatureToVerify(input);
		const result = await verifyPaystackSignature({
			payload: input.rawBody,
			signatureHeader: header,
			secret,
		});
		return { ok: result.ok, reason: result.reason };
	},

	parseWebhookEvent(rawBody: string): NormalizedPaymentEvent {
		let event: PaystackWebhookEvent;
		try {
			event = JSON.parse(rawBody);
		} catch {
			return {
				type: "unhandled",
				providerEventType: "unparseable",
				raw: rawBody,
			};
		}

		if (!event || typeof event !== "object" || !event.event) {
			return {
				type: "unhandled",
				providerEventType: "malformed",
				raw: event,
			};
		}

		if (event.event.startsWith("refund.")) {
			return refundEvent(event.event, event.data as unknown as PaystackRefundWebhookData, event);
		}

		if (DISPUTE_EVENTS.has(event.event)) {
			return disputeEvent(event.event, event.data as unknown as PaystackDisputeWebhookData, event);
		}

		if (event.event.startsWith("subscription.") || event.event === "invoice.payment_failed") {
			return subscriptionEvent(
				event.event,
				event.data as unknown as PaystackSubscriptionWebhookData,
				event,
			);
		}

		if (event.event === "paymentrequest.success") {
			return paymentRequestSuccessEvent(event.data, event);
		}

		// Paystack documents `charge.success` for completed payments. It has no
		// `charge.failed` webhook, so failures are left to the draft expiring.
		if (event.event === "charge.success") {
			const d = event.data;
			const metaDraftId = metadataOf(d?.metadata)?.orderDraftId;
			const orderDraftId =
				typeof metaDraftId === "string" && metaDraftId
					? metaDraftId
					: draftIdFromReference(d?.reference ?? "");
			// A renewal is a plan charge with Paystack's own reference and no
			// draft: core records it against the subscription, not as an order.
			const planCode = planCodeOf(d?.plan);
			if (
				(!orderDraftId && !planCode) ||
				!d.reference ||
				!d.currency ||
				typeof d.amount !== "number"
			) {
				return {
					type: "unhandled",
					providerEventType: event.event,
					raw: event,
				};
			}

			const customerName = [d.customer?.first_name, d.customer?.last_name]
				.filter(Boolean)
				.join(" ");

			const rawChannel = d.channel ?? d.authorization?.channel;
			const displayChannel =
				rawChannel === "mobile_money" ? "M-Pesa" : rawChannel === "card" ? "Card" : rawChannel;
			const splitSettlement = splitSettlementFrom(d.split, d.currency.toUpperCase());

			return {
				type: "charge.succeeded",
				orderDraftId: orderDraftId ?? "",
				providerId: "paystack",
				// The reference, not the numeric id: core passes paymentReference
				// to getPaymentStatus, and /transaction/verify accepts only the
				// reference. /refund accepts either.
				checkoutReference: d.reference,
				paymentReference: d.reference,
				// Paystack webhooks carry no event id (`data.id` is the transaction),
				// so the reference stands in for one. Core records it before the
				// handler runs, so two overlapping deliveries never both run it.
				// When confirming with Paystack fails, core releases the record, so
				// Paystack's retry still creates the order. Other failures keep it,
				// as they do for Stripe.
				providerEventId: `charge.success:${d.reference}`,
				amount: d.amount,
				currency: d.currency.toUpperCase(),
				customer: {
					email: d.customer?.email ?? "",
					...(customerName ? { name: customerName } : {}),
					...(d.customer?.phone ? { phone: d.customer.phone } : {}),
				},
				...(displayChannel ? { channel: displayChannel } : {}),
				...(splitSettlement ? { splitSettlement } : {}),
				...(planCode ? { subscription: chargeSubscription(planCode, d) } : {}),
				raw: event,
			};
		}

		return {
			type: "unhandled",
			providerEventType: event.event,
			raw: event,
		};
	},

	/**
	 * Verifies a reference that can't exist. Paystack answers
	 * `transaction_not_found` only for a key it accepts that can read
	 * transactions, which checkout needs; nothing is created.
	 */
	async checkConnection(
		ctx: PaymentProviderRuntimeContext,
		credentials: PaymentProviderCredentials,
	): Promise<ConnectionCheckResult> {
		const mode: ConnectionCheckResult["mode"] = /^(sk|rk)_live_/.test(credentials.secretKey)
			? "live"
			: /^(sk|rk)_test_/.test(credentials.secretKey)
				? "test"
				: undefined;
		const modeResult = mode ? { mode } : {};
		try {
			await call(ctx, {
				client: toPaystackClient(credentials),
				method: "GET",
				path: "/transaction/verify/dashcommerce-connection-check",
			});
		} catch (err) {
			if (!(err instanceof PaystackApiError)) throw err;
			if (err.body.code === "transaction_not_found") {
				return {
					ok: true,
					...modeResult,
					message: `Connected${mode ? ` in ${mode} mode` : ""}. The key can read transactions.`,
				};
			}
			if (err.status === 401 || err.status === 403) {
				return { ok: false, ...modeResult, message: `Paystack refused the key: ${err.message}` };
			}
			return {
				ok: false,
				...modeResult,
				message: `Paystack answered ${err.status}: ${err.message}`,
			};
		}
		return { ok: true, ...modeResult, message: `Connected${mode ? ` in ${mode} mode` : ""}.` };
	},

	async getPaymentStatus(
		ctx: PaymentProviderRuntimeContext,
		paymentOrCheckoutReference: string,
		credentials: PaymentProviderCredentials,
	): Promise<PaymentStatusResult> {
		const client = toPaystackClient(credentials);
		if (!paymentOrCheckoutReference) {
			return {
				status: "failed",
				reason: "No reference provided for payment status lookup",
			};
		}

		if (paymentOrCheckoutReference.startsWith(PAYMENT_REQUEST_PREFIX)) {
			return paymentRequestStatus(ctx, client, paymentOrCheckoutReference);
		}

		const data = await call<PaystackVerifyData>(ctx, {
			client,
			method: "GET",
			path: `/transaction/verify/${encodeURIComponent(paymentOrCheckoutReference)}`,
		});

		const status = TRANSACTION_STATUS[data.status];
		if (REVERSED.has(data.status) && Number.isSafeInteger(data.id)) {
			const refunded = await refundedTotal(ctx, client, data.id);
			if (refunded >= data.amount) {
				return {
					status: "failed",
					paymentReference: data.reference,
					amount: data.amount,
					currency: data.currency?.toUpperCase(),
					reason: `Payment was refunded in full at Paystack (${refunded} of ${data.amount})`,
				};
			}
		}
		const planCode = planCodeOf(data.plan, data.plan_object);
		return {
			status: status ?? "pending",
			paymentReference: data.reference,
			amount: data.amount,
			currency: data.currency?.toUpperCase(),
			reason: status ? data.gateway_response : `Unrecognised Paystack status: ${data.status}`,
			...(planCode
				? {
						subscription: chargeSubscription(planCode, {
							amount: data.amount,
							currency: data.currency,
							plan: data.plan_object ?? data.plan,
						}),
					}
				: {}),
		};
	},

	async getSubscription(
		ctx: PaymentProviderRuntimeContext,
		providerSubscriptionId: string,
		credentials: PaymentProviderCredentials,
	): Promise<ProviderSubscriptionInfo> {
		const row = await subscriptionForPlan(
			ctx,
			toPaystackClient(credentials),
			providerSubscriptionId,
		);
		return subscriptionInfo(providerSubscriptionId, row);
	},

	/**
	 * Paystack has no "cancel at period end": disabling stops future charges
	 * and the paid period stays. So this reports the subscription as active
	 * until the end of the period already paid for, whatever mode core asks.
	 */
	async cancelSubscription(
		ctx: PaymentProviderRuntimeContext,
		input: { providerSubscriptionId: string; atPeriodEnd?: boolean },
		credentials: PaymentProviderCredentials,
	): Promise<ProviderSubscriptionInfo> {
		const client = toPaystackClient(credentials);
		const row = await subscriptionForPlan(ctx, client, input.providerSubscriptionId);
		await call(ctx, {
			client,
			path: "/subscription/disable",
			body: { code: row.subscription_code, token: row.email_token },
		});
		const paidUntil = isoDate(row.next_payment_date);
		return {
			...subscriptionInfo(input.providerSubscriptionId, row),
			status: "active",
			cancelAtPeriodEnd: true,
			...(paidUntil ? { currentPeriodEnd: paidUntil } : {}),
		};
	},

	async resumeSubscription(
		ctx: PaymentProviderRuntimeContext,
		input: { providerSubscriptionId: string },
		credentials: PaymentProviderCredentials,
	): Promise<ProviderSubscriptionInfo> {
		const client = toPaystackClient(credentials);
		const row = await subscriptionForPlan(ctx, client, input.providerSubscriptionId);
		await call(ctx, {
			client,
			path: "/subscription/enable",
			body: { code: row.subscription_code, token: row.email_token },
		});
		return {
			...subscriptionInfo(input.providerSubscriptionId, row),
			status: "active",
			cancelAtPeriodEnd: false,
		};
	},

	async refund(
		ctx: PaymentProviderRuntimeContext,
		input: CreateRefundInput,
		credentials: PaymentProviderCredentials,
	): Promise<RefundResult> {
		if (!input.refundRequestId || !input.refundRequestId.trim()) {
			throw new Error(
				"Paystack refund requires a non-empty refundRequestId for operation idempotency",
			);
		}

		if (!REFUND_REQUEST_ID.test(input.refundRequestId)) {
			throw new Error(
				"Paystack refund needs a refundRequestId without spaces or brackets, so the merchant note can carry it",
			);
		}

		const client = toPaystackClient(credentials);
		const transactionRef = input.paymentReference;
		if (!transactionRef) {
			throw new Error("Paystack refund requires paymentReference");
		}
		if (transactionRef.startsWith(PAYMENT_REQUEST_PREFIX)) {
			throw new Error(
				"This counter sale was paid on a Paystack terminal; refund it in your Paystack dashboard",
			);
		}

		// Paystack accepts an identical second refund as a new one (tested on
		// 19 Nov 2026), so a retry with the same refundRequestId must find the
		// first refund rather than create another.
		const existing = await findRefundForRequest(ctx, client, transactionRef, input.refundRequestId);
		const data =
			existing ??
			(await call<PaystackRefundData>(ctx, {
				client,
				path: "/refund",
				body: {
					transaction: transactionRef,
					...(input.amount !== undefined ? { amount: input.amount } : {}),
					currency: input.currency.toUpperCase(),
					merchant_note: merchantNoteFor(input.refundRequestId, input.reason),
				},
			}));

		return {
			providerRefundId: String(data.id),
			refundRequestId: input.refundRequestId,
			status: REFUND_STATUS[data.status] ?? "pending",
			amount: data.amount,
			currency: (data.currency ?? input.currency).toUpperCase(),
		};
	},

	async listTerminals(
		ctx: PaymentProviderRuntimeContext,
		credentials: PaymentProviderCredentials,
	): Promise<PaymentProviderTerminal[]> {
		const rows = await call<PaystackTerminalRow[]>(ctx, {
			client: toPaystackClient(credentials),
			method: "GET",
			path: "/terminal?per_page=100",
		});
		const terminals: PaymentProviderTerminal[] = [];
		for (const row of Array.isArray(rows) ? rows : []) {
			const id = row?.terminal_id?.trim();
			if (!id) continue;
			terminals.push({ id, name: row.name?.trim() || row.serial_number?.trim() || id });
		}
		return terminals;
	},

	async startInPersonPayment(
		ctx: PaymentProviderRuntimeContext,
		input: StartInPersonPaymentInput,
		credentials: PaymentProviderCredentials,
	): Promise<StartInPersonPaymentResult> {
		const email = input.customer.email?.trim();
		if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			throw new Error("Paystack needs an email for every payment");
		}
		const currency = input.currency.trim().toUpperCase();
		const client = toPaystackClient(credentials);
		const withEmail = { ...input, customer: { ...input.customer, email } };
		const method = input.method;
		if (method.type === "phone") {
			return startPhonePayment(ctx, { ...withEmail, method }, client, currency);
		}
		return startTerminalPayment(ctx, { ...withEmail, method }, client, currency);
	},

	/**
	 * Banks and mobile money a vendor can be paid out to, in the account's own
	 * country only. Mobile money is whatever Paystack lists for that country:
	 * M-PESA, Airtel and Telkom in Kenya; MTN, AirtelTigo and Vodafone in Ghana.
	 */
	async listPayoutBanks(
		ctx: PaymentProviderRuntimeContext,
		country: string,
		credentials: PaymentProviderCredentials,
	): Promise<PaymentProviderBank[]> {
		const iso = country?.trim().toUpperCase();
		const paystackCountry = PAYSTACK_COUNTRY[iso];
		if (!paystackCountry) {
			throw new Error(
				`Paystack pays out to banks in ${Object.keys(PAYSTACK_COUNTRY).join(", ")} only`,
			);
		}
		await assertPayoutCountry(ctx, iso, credentials);
		const client = toPaystackClient(credentials);
		const lists = [
			`country=${encodeURIComponent(paystackCountry)}`,
			`currency=${COUNTRY_CURRENCY[iso]}&type=mobile_money`,
		];
		const banks = new Map<string, PaymentProviderBank>();
		for (const filter of lists) {
			let next: string | null = null;
			do {
				const page: PaystackBankPage = await callEnvelope<PaystackBankRow[]>(ctx, {
					client,
					method: "GET",
					path: `/bank?${filter}&perPage=100&use_cursor=true${next ? `&next=${encodeURIComponent(next)}` : ""}`,
				});
				for (const bank of page.data ?? []) {
					const code = bank?.code?.trim();
					const name = bank?.name?.trim();
					if (code && name && bank.active !== false && !banks.has(code)) {
						banks.set(code, { code, name });
					}
				}
				const cursor: unknown = page.meta?.next;
				next = typeof cursor === "string" && cursor !== "" ? cursor : null;
			} while (next);
		}
		return Array.from(banks.values());
	},

	async resolvePayoutAccount(
		ctx: PaymentProviderRuntimeContext,
		input: ResolvePayoutAccountInput,
		credentials: PaymentProviderCredentials,
	): Promise<{ accountName: string }> {
		const accountNumber = input.accountNumber?.trim();
		const bankCode = input.bankCode?.trim();
		if (!accountNumber || !bankCode) {
			throw new Error("Paystack account lookup needs an account number and a bank");
		}
		const data = await call<{ account_name?: string }>(ctx, {
			client: toPaystackClient(credentials),
			method: "GET",
			path: `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
		});
		const accountName = data?.account_name?.trim();
		if (!accountName) {
			throw new Error("Paystack returned no account name for that account");
		}
		return { accountName };
	},

	/**
	 * A Paystack subaccount for the vendor. Its `percentage_charge` is only
	 * the default for payments without a split; DashCommerce sends each
	 * vendor's exact share with every payment.
	 */
	async createPayoutAccount(
		ctx: PaymentProviderRuntimeContext,
		input: CreatePayoutAccountInput,
		credentials: PaymentProviderCredentials,
	): Promise<CreatedPayoutAccount> {
		const accountNumber = input.accountNumber?.trim();
		const bankCode = input.bankCode?.trim();
		const businessName = input.businessName?.trim();
		const businessEmail = input.businessEmail?.trim();
		const businessMobile = input.businessMobile?.trim();
		if (!accountNumber || !bankCode || !businessName) {
			throw new Error(
				"Paystack subaccount creation needs the account number, bank and business name",
			);
		}
		if ((input.splitType ?? "percentage") !== "percentage") {
			throw new Error(
				"Paystack subaccounts take a percentage default. Choose a percentage split for Paystack.",
			);
		}
		const fraction = input.splitValue ?? 0.1;
		if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
			throw new Error("The percentage split is a decimal from 0 to 1");
		}
		const country = input.country?.trim().toUpperCase();
		if (country) await assertPayoutCountry(ctx, country, credentials);

		const data = await call<{
			subaccount_code?: string;
			account_name?: string;
			settlement_bank?: string;
			account_number?: string;
			/** Paystack creates subaccounts unverified, then verifies them later. */
			is_verified?: boolean;
		}>(ctx, {
			client: toPaystackClient(credentials),
			path: "/subaccount",
			body: {
				business_name: businessName,
				settlement_bank: bankCode,
				account_number: accountNumber,
				percentage_charge: Math.round(fraction * 10000) / 100,
				...(businessEmail ? { primary_contact_email: businessEmail } : {}),
				...(businessMobile ? { primary_contact_phone: businessMobile } : {}),
				...(input.businessContact ? { primary_contact_name: input.businessContact } : {}),
				...(input.metadata ? { metadata: JSON.stringify(input.metadata) } : {}),
			},
		});

		const accountReference = data?.subaccount_code?.trim();
		if (!accountReference) {
			throw new Error("Paystack returned no subaccount code");
		}
		return {
			accountReference,
			accountName: data.account_name?.trim() || businessName,
			...(data.settlement_bank ? { bankName: data.settlement_bank } : {}),
			bankCode,
			...(input.country ? { country: input.country.trim().toUpperCase() } : {}),
			maskedAccountNumber: lastFour(accountNumber),
			// Usable at once; core shows "unverified" until Paystack verifies it.
			...(typeof data.is_verified === "boolean" ? { verified: data.is_verified } : {}),
		};
	},

	formatAmount(amount: number, currency: string): string {
		const major = (amount / 100).toFixed(2);
		return `${currency.toUpperCase()} ${major}`;
	},
};
