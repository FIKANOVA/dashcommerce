/**
 * Counter sales, 28 Nov addendum, through core's real routes with the mock
 * provider standing in for the gateway: counter sales off by default,
 * "Pay on their phone" (a payment link shown as a QR code and shared by
 * WhatsApp, SMS, copy or email), vendor products at the counter, and
 * methods offered by currency.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import { shareMessage, smsLink, whatsAppLink, whatsAppNumber } from "../src/admin/counter-share";
import { encodeQr } from "../src/admin/qr";
import {
	type InPersonMethodType,
	type PaymentStatusResult,
	type StartInPersonPaymentInput,
	type StartInPersonPaymentResult,
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import { adminApiRoutes } from "../src/routes/admin-api";
import sandbox from "../src/sandbox-entry";
import type { Order } from "../src/types";
import { decodeQr } from "./helpers/qr-decode";
import { ADMIN_USER, EDITOR_USER, deliverWebhook, makeRouteContext } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

type Caller = { id: string; email: string; role: number } | undefined;

const COUNTER_ROUTES = [
	"admin/counter/setup",
	"admin/counter/products",
	"admin/counter/sale",
	"admin/counter/status",
] as const;

interface ShopOptions {
	on?: boolean;
	methods?: InPersonMethodType[];
	splitMethods?: InPersonMethodType[];
	currency?: string;
	result?: Partial<StartInPersonPaymentResult>;
	inPersonCurrencies?: Partial<Record<InPersonMethodType, string[]>>;
}

/** A shop whose provider takes payment links (and phone prompts). */
function shop(opts: ShopOptions = {}) {
	const started: StartInPersonPaymentInput[] = [];
	let live: PaymentStatusResult = { status: "pending" };
	const provider = createMockPaymentProvider({
		supportedCurrencies: ["KES", "NGN", "GHS", "ZAR", "USD"],
		paymentStatus: () => live,
		inPerson: {
			methods: opts.methods ?? ["phone", "link"],
			...(opts.splitMethods ? { splitMethods: opts.splitMethods } : {}),
			onStart: (input) => started.push(input),
			...(opts.result ? { result: opts.result } : {}),
		},
	});
	registerPaymentProvider(
		opts.inPersonCurrencies ? { ...provider, inPersonCurrencies: opts.inPersonCurrencies } : provider,
	);
	const harness = makeRouteContext({
		"settings:paymentProvider": "mock",
		"settings:mockSecretKey": "test-key",
		"settings:mockWebhookSecret": "test-secret",
		"settings:defaultCurrency": opts.currency ?? "KES",
		"settings:storeCountry": "KE",
		...(opts.on === false ? {} : { "settings:counterSalesEnabled": true }),
	});
	// Priced in every currency Paystack takes.
	harness.products.set("prod_scarf", {
		id: "prod_scarf",
		status: "published",
		data: {
			title: "Club scarf",
			type: "simple",
			prices: {
				KES: { amount: 160_000 },
				NGN: { amount: 1_800_000 },
				GHS: { amount: 15_000 },
				ZAR: { amount: 22_000 },
				USD: { amount: 1_200 },
			},
			virtual: true,
			manage_stock: false,
		},
	});
	// A vendor's product.
	harness.products.set("prod_vendor_cap", {
		id: "prod_vendor_cap",
		status: "published",
		data: {
			title: "Vendor cap",
			type: "simple",
			prices: { KES: { amount: 100_000 } },
			virtual: true,
			manage_stock: false,
			vendor_id: "v1",
		},
	});
	harness.getCol("vendors").set("v1", {
		id: "v1",
		name: "Cap maker",
		email: "caps@example.com",
		onboardingStatus: "active",
		platformFeePercent: 10,
		detailsSubmitted: false,
		chargesEnabled: false,
		payoutsEnabled: false,
		paymentAccounts: {
			mock: { accountReference: "ACCT_v1", status: "active", updatedAt: "2026-01-01T00:00:00Z" },
		},
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	});
	const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
	(harness.ctx as unknown as { email: unknown }).email = {
		async send(msg: { to: string; subject: string; text: string; html: string }) {
			sent.push(msg);
		},
	};
	return {
		...harness,
		started,
		sent,
		setLive(next: PaymentStatusResult) {
			live = next;
		},
	};
}

async function call(
	ctx: PluginContext,
	route: string,
	user: Caller,
	opts: { method?: string; query?: string; input?: unknown } = {},
) {
	const routeCtx = {
		...ctx,
		request: new Request(`http://test/${route}${opts.query ?? ""}`, {
			method: opts.method ?? "POST",
		}),
		input: opts.input,
		...(user ? { user } : {}),
	} as unknown as RouteContext;
	const res = (await sandbox.routes[route].handler(routeCtx, ctx)) as Response;
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const LINK_SALE = {
	lines: [{ productId: "prod_scarf", quantity: 1 }],
	method: { type: "link" },
};

function status(ctx: PluginContext, draft: string, user: Caller = EDITOR_USER) {
	return call(ctx, "admin/counter/status", user, { method: "GET", query: `?draft=${draft}` });
}

function backdate(kvStore: Map<string, unknown>, draft: string) {
	const key = `counter:${draft}`;
	const record = kvStore.get(key) as { startedAt: string };
	kvStore.set(key, { ...record, startedAt: new Date(Date.now() - 6 * 60_000).toISOString() });
}

describe("counter sales are off until an admin turns them on", () => {
	it("every counter route answers 404 while off, for admins too", async () => {
		const { ctx, started } = shop({ on: false });
		for (const user of [ADMIN_USER, EDITOR_USER]) {
			for (const route of COUNTER_ROUTES) {
				const res = await call(ctx, route, user, {
					input: LINK_SALE,
					query: `?draft=${"0".repeat(32)}`,
				});
				expect(res.status).toBe(404);
			}
		}
		expect(started).toHaveLength(0);
	});

	async function saveSettings(ctx: PluginContext, user: Caller, input: Record<string, unknown>) {
		const routeCtx = {
			request: new Request("http://test/admin/settings", { method: "POST" }),
			input,
			user,
		} as unknown as RouteContext;
		const res = (await adminApiRoutes["admin/settings"].handler(routeCtx, ctx)) as Response;
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	it("an Admin turns them on and sets the idle time; the counter then opens", async () => {
		const { ctx } = shop({ on: false });
		const saved = await saveSettings(ctx, ADMIN_USER, {
			counterSalesEnabled: true,
			counterIdleMinutes: 20,
		});
		expect(saved.status).toBe(200);
		const setup = await call(ctx, "admin/counter/setup", EDITOR_USER, { method: "GET" });
		expect(setup.status).toBe(200);
		expect(setup.body).toMatchObject({ available: true, idleMinutes: 20 });
	});

	it("an Editor can't turn them on or change the idle time", async () => {
		const { ctx, kvStore } = shop({ on: false });
		expect((await saveSettings(ctx, EDITOR_USER, { counterSalesEnabled: true })).status).toBe(403);
		expect((await saveSettings(ctx, EDITOR_USER, { counterIdleMinutes: 600 })).status).toBe(403);
		expect(kvStore.has("settings:counterSalesEnabled")).toBe(false);
	});

	it("refuses an idle time outside 1 to 240 minutes", async () => {
		const { ctx } = shop({ on: false });
		expect((await saveSettings(ctx, ADMIN_USER, { counterIdleMinutes: 0 })).status).toBe(400);
		expect((await saveSettings(ctx, ADMIN_USER, { counterIdleMinutes: 241 })).status).toBe(400);
	});

	it("the counter closes after 15 minutes by default", async () => {
		const { ctx } = shop();
		const setup = await call(ctx, "admin/counter/setup", EDITOR_USER, { method: "GET" });
		expect(setup.body.idleMinutes).toBe(15);
	});
});

describe("Pay on their phone", () => {
	it("starts a link sale: the provider gets the draft metadata and returns its payment page", async () => {
		const { ctx, kvStore, started } = shop();
		const res = await call(ctx, "admin/counter/sale", EDITOR_USER, { input: LINK_SALE });
		expect(res.status).toBe(200);
		const draft = String(res.body.orderDraftId);
		expect(res.body).toMatchObject({
			status: "pending",
			method: "link",
			paymentUrl: `https://pay.mock.test/${draft}`,
		});
		expect(started[0]).toMatchObject({
			orderDraftId: draft,
			amount: 160_000,
			currency: "KES",
			method: { type: "link" },
			customer: { email: EDITOR_USER.email },
			metadata: {
				orderDraftId: draft,
				sessionId: `counter:${EDITOR_USER.id}`,
				kind: "payment",
				channel: "in_person",
			},
			returnUrl: `https://shop.example/thank-you/${draft}`,
		});
		expect(started[0]?.allocations).toBeUndefined();
		// Stock is held as for the other methods.
		expect(kvStore.has(`lock:${draft}`)).toBe(true);
		// The link stays on the waiting screen, and draws as a QR code that reads back.
		const waiting = await status(ctx, draft);
		expect(waiting.body.paymentUrl).toBe(`https://pay.mock.test/${draft}`);
		expect(decodeQr(encodeQr(String(waiting.body.paymentUrl)))).toBe(
			`https://pay.mock.test/${draft}`,
		);
	});

	it("charge.success creates exactly one order, a counter sale with its seller", async () => {
		const { ctx, getCol, setLive } = shop();
		const res = await call(ctx, "admin/counter/sale", EDITOR_USER, { input: LINK_SALE });
		const draft = String(res.body.orderDraftId);
		setLive({ status: "succeeded", amount: 160_000, currency: "KES" });
		const payload = JSON.stringify({
			id: "evt_link_1",
			type: "charge.succeeded",
			orderDraftId: draft,
			paymentReference: `mock_counter_${draft}`,
			amount: 160_000,
			currency: "KES",
			email: EDITOR_USER.email,
		});
		const [first, second] = await Promise.all([
			deliverWebhook(ctx, payload, { "x-mock-signature": "test-secret" }),
			status(ctx, draft),
		]);
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		await deliverWebhook(ctx, payload, { "x-mock-signature": "test-secret" });

		const orders = Array.from(getCol("orders").values()) as Order[];
		expect(orders).toHaveLength(1);
		expect(orders[0]).toMatchObject({ channel: "in_person", soldBy: EDITOR_USER.id });
		const paid = await status(ctx, draft);
		expect(paid.body).toMatchObject({ status: "paid", orderNumber: orders[0]?.orderNumber });
		// Paid: the link is no longer shown.
		expect(paid.body.paymentUrl).toBeUndefined();
	});

	it("a failed card on the provider's page doesn't end the sale: the customer can try again", async () => {
		const { ctx, kvStore, setLive } = shop();
		const res = await call(ctx, "admin/counter/sale", EDITOR_USER, { input: LINK_SALE });
		const draft = String(res.body.orderDraftId);
		setLive({ status: "failed", reason: "Declined" });
		expect((await status(ctx, draft)).body.status).toBe("pending");
		expect(kvStore.has(`lock:${draft}`)).toBe(true);
	});

	it("a link paid after the time-out still becomes the order", async () => {
		const { ctx, kvStore, getCol, setLive } = shop();
		const res = await call(ctx, "admin/counter/sale", EDITOR_USER, { input: LINK_SALE });
		const draft = String(res.body.orderDraftId);
		backdate(kvStore, draft);
		const timedOut = await status(ctx, draft);
		expect(timedOut.body).toMatchObject({ status: "failed", failure: "timed_out" });
		// The link expires with the sale on the counter screen.
		expect(timedOut.body.paymentUrl).toBeUndefined();
		expect(kvStore.has(`lock:${draft}`)).toBe(false);

		// The customer pays on the page they still have open.
		setLive({ status: "succeeded", amount: 160_000, currency: "KES" });
		const late = await status(ctx, draft);
		const orders = Array.from(getCol("orders").values()) as Order[];
		expect(orders).toHaveLength(1);
		expect(late.body).toMatchObject({ status: "paid", orderNumber: orders[0]?.orderNumber });
		expect(orders[0]?.channel).toBe("in_person");
	});

	for (const [currency, amount] of [
		["NGN", 1_800_000],
		["GHS", 15_000],
		["ZAR", 22_000],
		["USD", 1_200],
		["KES", 160_000],
	] as const) {
		it(`takes a ${currency} sale by link, offered first where there's no phone prompt`, async () => {
			const { ctx, getCol, started, setLive } = shop({
				currency,
				methods: ["phone", "terminal", "link"],
				inPersonCurrencies: { phone: ["KES"], terminal: ["NGN", "GHS", "ZAR", "USD"] },
			});
			const setup = await call(ctx, "admin/counter/setup", EDITOR_USER, { method: "GET" });
			// No terminals listed, so none offered; the phone prompt only in KES.
			expect(setup.body.methods).toEqual(currency === "KES" ? ["phone", "link"] : ["link"]);

			const res = await call(ctx, "admin/counter/sale", EDITOR_USER, {
				input: { ...LINK_SALE, currency },
			});
			expect(res.status).toBe(200);
			expect(started[0]).toMatchObject({ amount, currency, method: { type: "link" } });
			setLive({ status: "succeeded", amount, currency });
			const paid = await status(ctx, String(res.body.orderDraftId));
			expect(paid.body.status).toBe("paid");
			const order = Array.from(getCol("orders").values())[0] as Order;
			expect(order.total).toEqual({ amount, currency });
		});
	}

	it("refuses a phone prompt in a currency it doesn't take", async () => {
		const { ctx, started } = shop({ inPersonCurrencies: { phone: ["KES"] } });
		const res = await call(ctx, "admin/counter/sale", EDITOR_USER, {
			input: { ...LINK_SALE, currency: "NGN", method: { type: "phone", phone: "+2348012345678" } },
		});
		expect(res.status).toBe(400);
		expect(started).toHaveLength(0);
	});

	it("emails the exact link when staff entered the customer's email", async () => {
		const { ctx, sent } = shop();
		const res = await call(ctx, "admin/counter/sale", EDITOR_USER, {
			input: { ...LINK_SALE, customerEmail: "Fan@Example.com" },
		});
		const url = String(res.body.paymentUrl);
		expect(res.body.linkEmailed).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.to).toBe("fan@example.com");
		expect(sent[0]?.text).toContain(url);
		expect(sent[0]?.html).toContain(`href="${url}"`);
		expect(sent[0]?.subject).toBe("Pay KES\u00a01,600.00 to Shop");
	});

	it("sends nothing when no email was given", async () => {
		const { ctx, sent } = shop();
		const res = await call(ctx, "admin/counter/sale", EDITOR_USER, { input: LINK_SALE });
		expect(res.body.linkEmailed).toBeUndefined();
		expect(sent).toEqual([]);
	});

	it("refuses a provider page that isn't https, and lets the stock go", async () => {
		const { ctx, kvStore } = shop({ result: { paymentUrl: "javascript:alert(1)" } });
		const res = await call(ctx, "admin/counter/sale", EDITOR_USER, { input: LINK_SALE });
		expect(res.status).toBe(502);
		expect([...kvStore.keys()].some((k) => k.startsWith("lock:"))).toBe(false);
	});

	it("records the customer's phone, when typed, on a link sale", async () => {
		const { ctx, started } = shop();
		const res = await call(ctx, "admin/counter/sale", EDITOR_USER, {
			input: { ...LINK_SALE, customerPhone: "+254 712 345 678" },
		});
		expect(res.status).toBe(200);
		expect(started[0]?.customer.phone).toBe("+254712345678");
	});
});

describe("Pay on their phone: sharing", () => {
	const share = {
		url: "https://checkout.paystack.com/abc123",
		total: { amount: 160_000, currency: "KES" },
		shopName: "Corner Shop",
	};

	it("builds the WhatsApp message from the total, the shop and the link only", () => {
		expect(shareMessage(share)).toBe(
			"Pay KES\u00a01,600.00 for your purchase at Corner Shop: https://checkout.paystack.com/abc123",
		);
		expect(whatsAppLink(share)).toBe(
			`https://wa.me/?text=${encodeURIComponent(shareMessage(share))}`,
		);
	});

	it("addresses WhatsApp to the customer's number only when it has a country code", () => {
		expect(whatsAppLink({ ...share, customerPhone: "+254 712 345 678" })).toBe(
			`https://wa.me/254712345678?text=${encodeURIComponent(shareMessage(share))}`,
		);
		expect(whatsAppNumber("254712345678")).toBe("254712345678");
		expect(whatsAppNumber("00254712345678")).toBe("254712345678");
		// A national number: WhatsApp asks whom to send to, rather than guessing the country.
		expect(whatsAppNumber("0712345678")).toBeUndefined();
		expect(whatsAppNumber("call me")).toBeUndefined();
	});

	it("builds the SMS link with the same message", () => {
		expect(smsLink({ ...share, customerPhone: "0712 345 678" })).toBe(
			`sms:0712345678?&body=${encodeURIComponent(shareMessage(share))}`,
		);
		expect(smsLink({ ...share, customerPhone: "+254712345678" })).toBe(
			`sms:+254712345678?&body=${encodeURIComponent(shareMessage(share))}`,
		);
		expect(smsLink(share)).toBe(`sms:?&body=${encodeURIComponent(shareMessage(share))}`);
	});
});

describe("vendor products at the counter", () => {
	const VENDOR_SALE = {
		lines: [
			{ productId: "prod_vendor_cap", quantity: 1 },
			{ productId: "prod_scarf", quantity: 1 },
		],
		method: { type: "link" },
	};

	it("a link sale carries the vendor's share, as online checkout works it out", async () => {
		const { ctx, started } = shop({ splitMethods: ["link"] });
		const res = await call(ctx, "admin/counter/sale", EDITOR_USER, { input: VENDOR_SALE });
		expect(res.status).toBe(200);
		// KES 1,000 cap less the vendor's 10% fee; the shop keeps its scarf and the fee.
		expect(started[0]?.allocations).toEqual([
			{ vendorId: "v1", accountReference: "ACCT_v1", amountMinor: 90_000 },
		]);
		expect(started[0]?.platformRemainderMinor).toBe(170_000);
	});

	it("records the vendor's share on the order when the status check creates it first", async () => {
		const { ctx, getCol, setLive } = shop({ splitMethods: ["link"] });
		const res = await call(ctx, "admin/counter/sale", EDITOR_USER, { input: VENDOR_SALE });
		const draft = String(res.body.orderDraftId);
		// The provider reports no settlement: the shares core sent are recorded.
		setLive({ status: "succeeded", amount: 260_000, currency: "KES" });
		expect((await status(ctx, draft)).body.status).toBe("paid");
		const order = Array.from(getCol("orders").values())[0] as Order;
		expect(order.providerSplits).toMatchObject({
			providerId: "mock",
			allocations: [
				{ vendorId: "v1", accountReference: "ACCT_v1", amount: { amount: 90_000, currency: "KES" } },
			],
			platformRemainder: { amount: 170_000, currency: "KES" },
		});
	});

	it("prefers the settlement the provider reports when the status check creates the order", async () => {
		const { ctx, getCol, setLive } = shop({ splitMethods: ["link"] });
		const res = await call(ctx, "admin/counter/sale", EDITOR_USER, { input: VENDOR_SALE });
		const draft = String(res.body.orderDraftId);
		setLive({
			status: "succeeded",
			amount: 260_000,
			currency: "KES",
			splitSettlement: {
				allocations: [{ accountReference: "ACCT_v1", amountMinor: 90_000 }],
				platformRemainderMinor: 166_100,
				providerFeeMinor: 3_900,
				currency: "KES",
			},
		});
		await status(ctx, draft);
		const order = Array.from(getCol("orders").values())[0] as Order;
		expect(order.providerSplits).toMatchObject({
			allocations: [{ vendorId: "v1", amount: { amount: 90_000, currency: "KES" } }],
			platformRemainder: { amount: 166_100, currency: "KES" },
			providerFee: { amount: 3_900, currency: "KES" },
		});
	});

	it("offers only the methods that split, and refuses the others", async () => {
		const { ctx, started } = shop({ splitMethods: ["link"] });
		const setup = await call(ctx, "admin/counter/setup", EDITOR_USER, { method: "GET" });
		expect(setup.body).toMatchObject({ methods: ["phone", "link"], splitMethods: ["link"] });
		const products = await call(ctx, "admin/counter/products", EDITOR_USER, { method: "GET" });
		const items = products.body.items as Array<{ productId: string; vendor?: boolean }>;
		expect(items.find((p) => p.productId === "prod_vendor_cap")?.vendor).toBe(true);

		const phone = await call(ctx, "admin/counter/sale", EDITOR_USER, {
			input: { ...VENDOR_SALE, method: { type: "phone", phone: "0712345678" } },
		});
		expect(phone.status).toBe(409);
		expect(String((phone.body.error as { message: string }).message)).toBe(
			"Vendor cap belongs to a vendor; take payment by Pay on their phone.",
		);
		expect(started).toHaveLength(0);
	});

	it("keeps the sell-it-online refusal where no method splits", async () => {
		const { ctx, started } = shop();
		const products = await call(ctx, "admin/counter/products", EDITOR_USER, { method: "GET" });
		const items = products.body.items as Array<{ productId: string }>;
		expect(items.some((p) => p.productId === "prod_vendor_cap")).toBe(false);
		const res = await call(ctx, "admin/counter/sale", EDITOR_USER, { input: VENDOR_SALE });
		expect(res.status).toBe(409);
		expect(String((res.body.error as { message: string }).message)).toBe(
			"Vendor cap belongs to a vendor; sell it online.",
		);
		expect(started).toHaveLength(0);
	});

	it("refuses when the vendor has no payout account for the provider", async () => {
		const { ctx, getCol, started, kvStore } = shop({ splitMethods: ["link"] });
		const vendor = getCol("vendors").get("v1") as Record<string, unknown>;
		getCol("vendors").set("v1", { ...vendor, paymentAccounts: {} });
		const res = await call(ctx, "admin/counter/sale", EDITOR_USER, { input: VENDOR_SALE });
		expect(res.status).toBe(409);
		expect(started).toHaveLength(0);
		expect([...kvStore.keys()].some((k) => k.startsWith("lock:"))).toBe(false);
	});
});
