/**
 * Counter sales (in-person checkout) — admin routes.
 *
 *   GET  /admin/counter/setup              provider, methods, terminals, currency
 *   GET  /admin/counter/products?q=&currency=   products staff can sell
 *   POST /admin/counter/sale               price the lines, hold stock, store the
 *                                          draft and ask the provider for payment
 *   GET  /admin/counter/status?draft=      pending | paid (order number) | failed
 *
 * Staff add products at the counter; the customer pays by a prompt on their
 * phone (M-PESA) or on a card terminal. The order is created through the same
 * path as an online order (stock, coupons, receipt email), from the signed
 * webhook or from the status check, whichever confirms first, marked
 * `channel: "in_person"` with the staff member in `soldBy`.
 *
 * Editors and Admins may sell. Refunds stay admin-only (routes/admin-api.ts).
 */

import type { PluginContext, RouteContext } from "emdash";
import { recalculate } from "../cart/calculate";
import { holdStock, linkAttempts, releaseLock } from "../cart/lock";
import { newCart } from "../cart/store";
import { findOrderByPaymentIntent } from "../orders/create";
import {
	DEFAULT_PAYMENT_PROVIDER_ID,
	getPaymentProvider,
	isCurrencyNotSupportedError,
	loadPaymentProviderCredentials,
	type PaymentProvider,
	type PaymentProviderCredentials,
	type StartInPersonPaymentInput,
} from "../payment-provider";
import { normalizeProductFields } from "../products/normalize";
import { resolvePrice } from "../products/pricing";
import type { Address, CartLineItem, CartState } from "../types";
import { randomId } from "../util/ids";
import {
	type CheckoutDraftSnapshot,
	draftKey,
	readPricingPolicy,
	repriceAndCheckStock,
} from "./checkout";
import { handleNormalizedChargeSucceeded } from "./webhook";

/** EmDash's `Role.EDITOR`. Plugin routes see the caller's role as a number. */
const EMDASH_EDITOR_ROLE = 40;

const HOLD_TTL_MS = 15 * 60 * 1000;
/**
 * How long the page waits for the customer before calling it timed out and
 * releasing the stock. An M-PESA prompt expires on the phone well before
 * this; a terminal needs the customer to walk up to it.
 */
const COUNTER_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_LINES = 50;
const MAX_QUANTITY = 999;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TERMINAL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DRAFT_ID_RE = /^[0-9a-f]{32}$/;

type CounterMethod = StartInPersonPaymentInput["method"];

/** What the status route reports, kept in KV under `counter:<draftId>`. */
export interface CounterSaleRecord {
	orderDraftId: string;
	providerId: string;
	method: CounterMethod["type"];
	paymentReference: string;
	amount: number;
	currency: string;
	soldBy: string;
	startedAt: string;
	status: "pending" | "paid" | "failed";
	/** `declined` (refused or cancelled at the provider) or `timed_out`. */
	failure?: "declined" | "timed_out";
	reason?: string;
	orderId?: string;
	orderNumber?: string;
}

function counterKey(orderDraftId: string): string {
	return `counter:${orderDraftId}`;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Errors in EmDash's shape, so the admin shows the message itself. */
function fail(message: string, status: number, extra: Record<string, unknown> = {}): Response {
	return json({ error: { code: "COUNTER_SALE", message }, ...extra }, status);
}

function getCtx(routeCtx: RouteContext, ctx?: PluginContext): PluginContext {
	return (ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
}

/** The signed-in Editor or Admin, or null for anyone else (or no user). */
function seller(routeCtx: RouteContext): { id: string; email?: string } | null {
	const user = routeCtx.user;
	if (!user || typeof user.role !== "number" || user.role < EMDASH_EDITOR_ROLE) return null;
	if (typeof user.id !== "string" || user.id === "") return null;
	return { id: user.id, ...(typeof user.email === "string" ? { email: user.email } : {}) };
}

function notAllowed(): Response {
	return json(
		{
			error: {
				code: "COUNTER_NOT_ALLOWED",
				message: "Only an editor or admin can sell at the counter.",
			},
		},
		403,
	);
}

interface CounterProvider {
	provider: PaymentProvider;
	credentials: PaymentProviderCredentials;
}

/** The shop's payment provider, if it can take in-person payments. */
async function counterProvider(ctx: PluginContext): Promise<CounterProvider | string> {
	const id = (await ctx.kv.get<string>("settings:paymentProvider")) ?? DEFAULT_PAYMENT_PROVIDER_ID;
	const provider = getPaymentProvider(id);
	if (!provider) return `Payment provider "${id}" is not available.`;
	if (
		!provider.startInPersonPayment ||
		!provider.getPaymentStatus ||
		(provider.inPersonMethods ?? []).length === 0
	) {
		return `${provider.label} can't take in-person payments.`;
	}
	const credentials = await loadPaymentProviderCredentials(ctx.kv, provider.id);
	if (!credentials) return `Add your ${provider.label} keys in Settings first.`;
	return { provider, credentials };
}

async function shopCurrency(ctx: PluginContext, requested: unknown): Promise<string> {
	if (typeof requested === "string" && /^[A-Za-z]{3}$/.test(requested.trim())) {
		return requested.trim().toUpperCase();
	}
	return ((await ctx.kv.get<string>("settings:defaultCurrency")) ?? "USD").toUpperCase();
}

// ────────────────────────────────────────────────────────────────────────────
// Input validation
// ────────────────────────────────────────────────────────────────────────────

interface SaleLine {
	productId: string;
	variantId?: string;
	quantity: number;
}

interface SaleInput {
	lines: SaleLine[];
	method: CounterMethod;
	customerEmail?: string;
	currency: unknown;
	/** The draft of the attempt this one retries. */
	retryOf?: string;
}

/**
 * A phone number the provider can place: international (`+254712345678` or
 * `254712345678`) or national with its leading 0 (`0712345678`). A bare
 * `712345678` is refused: without the 0 or the country code we can't tell
 * which country it is in.
 */
export function normalisePhone(raw: string): string | null {
	const phone = raw.replace(/[\s().-]/g, "");
	return /^(\+\d{8,15}|0\d{8,14}|[1-9]\d{10,14})$/.test(phone) ? phone : null;
}

function parseSaleInput(raw: unknown): SaleInput | string {
	if (!raw || typeof raw !== "object") return "Send the sale as JSON.";
	const body = raw as Record<string, unknown>;

	if (!Array.isArray(body.lines) || body.lines.length === 0) return "Add at least one product.";
	if (body.lines.length > MAX_LINES) return `A counter sale takes up to ${MAX_LINES} lines.`;
	const merged = new Map<string, SaleLine>();
	for (const entry of body.lines) {
		if (!entry || typeof entry !== "object") return "Each line needs a product and a quantity.";
		const line = entry as Record<string, unknown>;
		const productId = line.productId;
		const variantId = line.variantId;
		const quantity = line.quantity;
		if (typeof productId !== "string" || !ID_RE.test(productId))
			return "A line has no valid product.";
		if (
			variantId !== undefined &&
			variantId !== null &&
			(typeof variantId !== "string" || !ID_RE.test(variantId))
		) {
			return "A line has an invalid variant.";
		}
		if (
			typeof quantity !== "number" ||
			!Number.isInteger(quantity) ||
			quantity < 1 ||
			quantity > MAX_QUANTITY
		) {
			return `Quantities must be whole numbers from 1 to ${MAX_QUANTITY}.`;
		}
		const key = `${productId}:${typeof variantId === "string" ? variantId : ""}`;
		const prev = merged.get(key);
		const total = (prev?.quantity ?? 0) + quantity;
		if (total > MAX_QUANTITY) return `Quantities must be whole numbers from 1 to ${MAX_QUANTITY}.`;
		merged.set(key, {
			productId,
			...(typeof variantId === "string" ? { variantId } : {}),
			quantity: total,
		});
	}

	const method = body.method as Record<string, unknown> | undefined;
	let parsedMethod: CounterMethod;
	if (method?.type === "phone") {
		const phone = typeof method.phone === "string" ? normalisePhone(method.phone) : null;
		if (!phone) {
			return "Enter the customer's phone number with its leading 0 or country code, for example 0712345678 or +254712345678.";
		}
		parsedMethod = { type: "phone", phone };
	} else if (method?.type === "terminal") {
		const terminalId = method.terminalId;
		if (typeof terminalId !== "string" || !TERMINAL_ID_RE.test(terminalId))
			return "Choose a terminal.";
		parsedMethod = { type: "terminal", terminalId };
	} else {
		return "Choose how the customer pays: phone or terminal.";
	}

	let customerEmail: string | undefined;
	if (
		body.customerEmail !== undefined &&
		body.customerEmail !== null &&
		body.customerEmail !== ""
	) {
		if (typeof body.customerEmail !== "string") return "The customer's email is not valid.";
		const email = body.customerEmail.trim().toLowerCase();
		if (email.length > 254 || !EMAIL_RE.test(email)) return "The customer's email is not valid.";
		customerEmail = email;
	}

	let retryOf: string | undefined;
	if (body.retryOf !== undefined && body.retryOf !== null) {
		if (typeof body.retryOf !== "string" || !DRAFT_ID_RE.test(body.retryOf))
			return "Invalid retry.";
		retryOf = body.retryOf;
	}

	return {
		lines: [...merged.values()],
		method: parsedMethod,
		...(retryOf ? { retryOf } : {}),
		...(customerEmail ? { customerEmail } : {}),
		currency: body.currency,
	};
}

// ────────────────────────────────────────────────────────────────────────────
// Sale
// ────────────────────────────────────────────────────────────────────────────

/** Order rows need an address; a counter sale has none, only the shop's country. */
function counterAddress(country: string, phone?: string): Address {
	return {
		firstName: "Counter",
		lastName: "sale",
		line1: "",
		city: "",
		region: "",
		postalCode: "",
		country,
		...(phone ? { phone } : {}),
	};
}

async function startSale(
	ctx: PluginContext,
	routeCtx: RouteContext,
	staff: { id: string; email?: string },
): Promise<Response> {
	if (routeCtx.request.method !== "POST") return fail("Method not allowed", 405);
	const input = parseSaleInput(routeCtx.input);
	if (typeof input === "string") return fail(input, 400);

	const resolved = await counterProvider(ctx);
	if (typeof resolved === "string") return fail(resolved, 409);
	const { provider, credentials } = resolved;
	if (!(provider.inPersonMethods ?? []).includes(input.method.type)) {
		return fail(`${provider.label} can't take payments by ${input.method.type}.`, 409);
	}
	if (input.method.type === "terminal") {
		const terminalId = input.method.terminalId;
		const terminals = provider.listTerminals ? await provider.listTerminals(ctx, credentials) : [];
		if (!terminals.some((t) => t.id === terminalId)) {
			return fail("That terminal isn't on your account.", 400);
		}
	}

	// Retry: the earlier attempt may have been paid after it timed out (a
	// late tap on the terminal). Check it first so the customer isn't
	// charged twice.
	if (input.retryOf) {
		const earlier = await ctx.kv.get<CounterSaleRecord>(counterKey(input.retryOf));
		if (earlier) {
			const now = await checkStatus(ctx, earlier);
			if (now.status === "paid") {
				return fail(`The earlier attempt was paid: order ${now.orderNumber ?? ""}.`, 409, {
					sale: publicRecord(now),
				});
			}
			if (now.status === "pending") {
				return fail("The earlier attempt is still waiting for the customer.", 409, {
					sale: publicRecord(now),
				});
			}
		}
	}

	const currency = await shopCurrency(ctx, input.currency);
	if (!provider.supportsCurrency(currency)) {
		return fail(`${provider.label} can't take payments in ${currency}.`, 400);
	}

	// Products: published, sold in this currency, not a subscription and not
	// a vendor's (counter sales don't split payments yet).
	if (!ctx.content) return fail("Products are unavailable.", 500);
	const items: CartLineItem[] = [];
	for (const line of input.lines) {
		const record = await ctx.content.get("products", line.productId);
		if (!record || record.status !== "published") {
			return fail("A product in this sale is not available.", 409);
		}
		const fields = normalizeProductFields(record.data as Record<string, unknown>);
		if (fields.subscriptionConfig) {
			return fail(`${fields.title} is a subscription; sell it online.`, 409);
		}
		if (fields.vendorId) {
			return fail(`${fields.title} belongs to a vendor; sell it online.`, 409);
		}
		items.push({
			lineId: randomId(),
			productId: line.productId,
			...(line.variantId ? { variantId: line.variantId } : {}),
			quantity: line.quantity,
			unitPrice: { amount: 0, currency },
			lineSubtotal: { amount: 0, currency },
			title: fields.title,
			isDigital: fields.isVirtual || fields.isDownloadable,
		});
	}

	// One hold per staff member: starting again (Retry) replaces the hold of
	// their earlier, unpaid attempt rather than reserving the stock twice.
	const sessionId = `counter:${staff.id}`;
	const country = ((await ctx.kv.get<string>("settings:storeCountry")) ?? "KE").toUpperCase();
	const phone = input.method.type === "phone" ? input.method.phone : undefined;
	const email = input.customerEmail ?? staff.email;
	if (!email || !EMAIL_RE.test(email)) {
		return fail("Enter the customer's email; your account has none to use instead.", 400);
	}
	const address = counterAddress(country, phone);
	const base: CartState = {
		...newCart(sessionId, currency, staff.id),
		items,
		customerEmail: email,
		billingAddress: address,
		shippingAddress: address,
	};

	const { items: priced, errors, stockEntries } = await repriceAndCheckStock(ctx, base);
	if (errors.length > 0) {
		return fail("Some products can't be sold.", 409, { errors });
	}
	const cart = recalculate({ ...base, items: priced }, await readPricingPolicy(ctx));
	if (cart.total.amount <= 0) return fail("The total must be more than zero.", 400);

	const orderDraftId = randomId();
	await holdStock(ctx, orderDraftId, sessionId, stockEntries, { ttlMs: HOLD_TTL_MS });
	// If the earlier attempt is still paid late as well, its order is held
	// for review as a second payment for one sale (see earlierPaidAttempt).
	if (input.retryOf) await linkAttempts(ctx, input.retryOf, orderDraftId);
	const snapshot: CheckoutDraftSnapshot = {
		cart,
		ttlMs: HOLD_TTL_MS,
		createdAt: new Date().toISOString(),
		providerId: provider.id,
		channel: "in_person",
		soldBy: staff.id,
	};
	await ctx.kv.set(draftKey(orderDraftId), snapshot);

	let started: Awaited<ReturnType<NonNullable<PaymentProvider["startInPersonPayment"]>>>;
	try {
		// Checked in counterProvider.
		const start = provider.startInPersonPayment as NonNullable<
			PaymentProvider["startInPersonPayment"]
		>;
		started = await start(
			ctx,
			{
				orderDraftId,
				amount: cart.total.amount,
				currency,
				customer: { email, ...(phone ? { phone } : {}) },
				method: input.method,
			},
			credentials,
		);
	} catch (err) {
		await releaseLock(ctx, orderDraftId);
		await ctx.kv.delete(draftKey(orderDraftId));
		if (isCurrencyNotSupportedError(err)) {
			return fail(`${provider.label} can't take payments in ${err.currency}.`, 400);
		}
		const message = err instanceof Error ? err.message : String(err);
		ctx.log.warn("Counter sale: the provider refused to start the payment", {
			providerId: provider.id,
			orderDraftId,
			error: message,
		});
		return fail(`${provider.label} couldn't start the payment: ${message}`, 502);
	}

	const record: CounterSaleRecord = {
		orderDraftId,
		providerId: provider.id,
		method: input.method.type,
		paymentReference: started.paymentReference,
		amount: cart.total.amount,
		currency,
		soldBy: staff.id,
		startedAt: snapshot.createdAt,
		status: "pending",
	};
	await ctx.kv.set(draftKey(orderDraftId), {
		...snapshot,
		checkoutReference: started.paymentReference,
	});
	await ctx.kv.set(counterKey(orderDraftId), record);

	if (started.status === "failed") {
		return json({
			...publicRecord(await settleFailed(ctx, record, "declined", started.reason)),
			total: cart.total,
		});
	}
	// A provider that confirms at once still goes through the status check,
	// so the order is created in one place.
	const current = started.status === "succeeded" ? await checkStatus(ctx, record) : record;
	return json({ ...publicRecord(current), total: cart.total });
}

// ────────────────────────────────────────────────────────────────────────────
// Status
// ────────────────────────────────────────────────────────────────────────────

function publicRecord(record: CounterSaleRecord) {
	return {
		orderDraftId: record.orderDraftId,
		status: record.status,
		method: record.method,
		amount: record.amount,
		currency: record.currency,
		...(record.failure ? { failure: record.failure } : {}),
		...(record.reason ? { reason: record.reason } : {}),
		...(record.orderId ? { orderId: record.orderId } : {}),
		...(record.orderNumber ? { orderNumber: record.orderNumber } : {}),
	};
}

async function settleFailed(
	ctx: PluginContext,
	record: CounterSaleRecord,
	failure: "declined" | "timed_out",
	reason?: string,
): Promise<CounterSaleRecord> {
	// The draft stays, so a payment that still lands late becomes the order
	// (through the webhook, or the status check asking again); only the
	// stock is let go. Paystack offers no way to void a request already on
	// a terminal (archiving one only stops it being verified), so nothing is
	// cancelled at the provider.
	await releaseLock(ctx, record.orderDraftId);
	const failed: CounterSaleRecord = {
		...record,
		status: "failed",
		failure,
		...(reason ? { reason } : {}),
	};
	await ctx.kv.set(counterKey(record.orderDraftId), failed);
	return failed;
}

async function markPaid(
	ctx: PluginContext,
	record: CounterSaleRecord,
	order: { id: string; orderNumber: string },
): Promise<CounterSaleRecord> {
	// A late payment after a time-out: drop the failure, the customer paid.
	const { failure: _failure, reason: _reason, ...rest } = record;
	const paid: CounterSaleRecord = {
		...rest,
		status: "paid",
		orderId: order.id,
		orderNumber: order.orderNumber,
	};
	await ctx.kv.set(counterKey(record.orderDraftId), paid);
	return paid;
}

async function checkStatus(
	ctx: PluginContext,
	record: CounterSaleRecord,
): Promise<CounterSaleRecord> {
	if (record.status === "paid") return record;

	// The webhook may already have created the order. A late payment after a
	// timeout still counts: the customer paid.
	const existing = await findOrderByPaymentIntent(ctx, record.paymentReference);
	if (existing) return markPaid(ctx, record, existing);
	// A declined phone prompt is final. A timed-out sale, or any terminal
	// sale (a card can still be tapped after we stop waiting, and providers
	// may not send a webhook core maps), is asked about again so a late
	// payment still becomes the order.
	const recheck =
		record.status === "pending" || record.failure === "timed_out" || record.method === "terminal";
	if (!recheck) return record;
	const settled = record.status === "failed";

	const provider = getPaymentProvider(record.providerId);
	const credentials = await loadPaymentProviderCredentials(ctx.kv, record.providerId);
	if (!provider?.getPaymentStatus || !credentials) return record;

	let live: Awaited<ReturnType<NonNullable<PaymentProvider["getPaymentStatus"]>>>;
	try {
		live = await provider.getPaymentStatus(ctx, record.paymentReference, credentials);
	} catch (err) {
		ctx.log.warn("Counter sale: status check failed; still waiting", {
			orderDraftId: record.orderDraftId,
			error: err instanceof Error ? err.message : String(err),
		});
		return !settled && timedOut(record) ? settleFailed(ctx, record, "timed_out") : record;
	}

	if (live.status === "succeeded") {
		try {
			await handleNormalizedChargeSucceeded(ctx, {
				type: "charge.succeeded",
				orderDraftId: record.orderDraftId,
				providerId: record.providerId,
				providerEventId: `counter:${record.orderDraftId}`,
				checkoutReference: record.paymentReference,
				paymentReference: live.paymentReference ?? record.paymentReference,
				amount: live.amount ?? record.amount,
				currency: live.currency ?? record.currency,
				customer: { email: "" },
				raw: null,
			});
		} catch (err) {
			// The webhook may have won the race to create the order.
			ctx.log.warn("Counter sale: order creation from the status check failed", {
				orderDraftId: record.orderDraftId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		const order =
			(await findOrderByPaymentIntent(ctx, live.paymentReference ?? record.paymentReference)) ??
			(await findOrderByPaymentIntent(ctx, record.paymentReference));
		return order ? markPaid(ctx, record, order) : record;
	}
	if (settled) return record;
	if (live.status === "failed") {
		return settleFailed(ctx, record, "declined", live.reason);
	}
	return timedOut(record) ? settleFailed(ctx, record, "timed_out") : record;
}

function timedOut(record: CounterSaleRecord): boolean {
	return Date.now() - Date.parse(record.startedAt) > COUNTER_TIMEOUT_MS;
}

// ────────────────────────────────────────────────────────────────────────────
// Setup + products
// ────────────────────────────────────────────────────────────────────────────

async function setup(ctx: PluginContext): Promise<Response> {
	const currency = await shopCurrency(ctx, undefined);
	const resolved = await counterProvider(ctx);
	if (typeof resolved === "string") {
		return json({ available: false, message: resolved, currency, methods: [], terminals: [] });
	}
	const { provider, credentials } = resolved;
	const methods = [...(provider.inPersonMethods ?? [])];
	let terminals: Array<{ id: string; name: string }> = [];
	let terminalMessage: string | undefined;
	if (methods.includes("terminal") && provider.listTerminals) {
		try {
			terminals = await provider.listTerminals(ctx, credentials);
		} catch (err) {
			terminalMessage = `Couldn't list your terminals: ${err instanceof Error ? err.message : String(err)}`;
		}
	}
	return json({
		available: true,
		providerId: provider.id,
		providerLabel: provider.label,
		currency,
		// Terminals are offered only when the provider lists some.
		methods: methods.filter((m) => m !== "terminal" || terminals.length > 0),
		terminals,
		...(terminalMessage ? { terminalMessage } : {}),
	});
}

async function listProducts(ctx: PluginContext, req: Request): Promise<Response> {
	if (!ctx.content?.list) return json({ items: [] });
	const url = new URL(req.url);
	const q = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 100);
	const currency = await shopCurrency(ctx, url.searchParams.get("currency"));
	// Scans at most 200 products, like the low-stock widget.
	const result = await ctx.content.list("products", { limit: 200 });
	const items = [];
	for (const row of result.items) {
		if (
			(row as { status?: string }).status !== undefined &&
			(row as { status?: string }).status !== "published"
		) {
			continue;
		}
		const fields = normalizeProductFields(row.data as Record<string, unknown>);
		if (q && !fields.title.toLowerCase().includes(q)) continue;
		if (fields.subscriptionConfig || fields.vendorId) continue;
		const price = resolvePrice({ product: fields, variant: null, currency });
		if (!price) continue;
		items.push({
			productId: row.id,
			title: fields.title,
			price: price.unit,
			stockQuantity: fields.manageStock ? fields.stockQuantity : null,
		});
		if (items.length >= 50) break;
	}
	return json({ items, currency });
}

export const counterRoutes = {
	"admin/counter/setup": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			if (!seller(routeCtx)) return notAllowed();
			return setup(getCtx(routeCtx, _c));
		},
	},
	"admin/counter/products": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			if (!seller(routeCtx)) return notAllowed();
			return listProducts(getCtx(routeCtx, _c), routeCtx.request);
		},
	},
	"admin/counter/sale": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const staff = seller(routeCtx);
			if (!staff) return notAllowed();
			return startSale(getCtx(routeCtx, _c), routeCtx, staff);
		},
	},
	"admin/counter/status": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			if (!seller(routeCtx)) return notAllowed();
			const ctx = getCtx(routeCtx, _c);
			const draft = new URL(routeCtx.request.url).searchParams.get("draft") ?? "";
			if (!DRAFT_ID_RE.test(draft)) return fail("Missing or invalid draft id", 400);
			const record = await ctx.kv.get<CounterSaleRecord>(counterKey(draft));
			if (!record) return fail("No counter sale with that id", 404);
			return json(publicRecord(await checkStatus(ctx, record)));
		},
	},
};
