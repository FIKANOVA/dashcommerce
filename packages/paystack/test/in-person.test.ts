/**
 * Paystack counter sales: an M-PESA prompt through /charge, and a payment
 * request pushed to a card terminal. The test account has no terminals,
 * so the terminal path runs against a stand-in only.
 */

import { describe, expect, it } from "bun:test";
import type {
	PaymentProviderRuntimeContext,
	StartInPersonPaymentInput,
} from "@dashcommerce/core/payment-provider";
import { isCurrencyNotSupportedError } from "@dashcommerce/core/payment-provider";
import { paystackPaymentProvider, paystackPhone } from "../src/provider";

const credentials = { secretKey: "sk_test_1234567890abcdef" };
const DRAFT = "0123456789abcdef0123456789abcdef";

function ok(data: unknown): Response {
	return new Response(JSON.stringify({ status: true, message: "ok", data }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/** Records every call; answers from `routes` by "METHOD /path". */
function stand(routes: Record<string, unknown>) {
	const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
	const ctx: PaymentProviderRuntimeContext = {
		http: {
			async fetch(url: string, init?: RequestInit) {
				const { pathname, search } = new URL(url);
				const method = init?.method ?? "GET";
				calls.push({
					method,
					path: `${pathname}${search}`,
					...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
				});
				const key = `${method} ${pathname}`;
				if (!(key in routes)) {
					return new Response(JSON.stringify({ status: false, message: "Not found" }), {
						status: 404,
					});
				}
				return ok(routes[key]);
			},
		},
		log: { info() {}, warn() {}, error() {} },
	};
	return { ctx, calls };
}

function input(overrides: Partial<StartInPersonPaymentInput> = {}): StartInPersonPaymentInput {
	return {
		orderDraftId: DRAFT,
		amount: 160000,
		currency: "KES",
		customer: { email: "till@example.com" },
		method: { type: "phone", phone: "0712345678" },
		...overrides,
	};
}

const start = paystackPaymentProvider.startInPersonPayment as NonNullable<
	typeof paystackPaymentProvider.startInPersonPayment
>;

describe("Paystack counter sales", () => {
	it("declares phone and terminal", () => {
		expect(paystackPaymentProvider.inPersonMethods).toEqual(["phone", "terminal"]);
	});

	it("writes Kenyan numbers with the country code", () => {
		expect(paystackPhone("0712345678", "KES")).toBe("+254712345678");
		expect(paystackPhone("254110000000", "KES")).toBe("+254110000000");
		expect(paystackPhone("+254710000000", "KES")).toBe("+254710000000");
	});

	describe("phone", () => {
		it("sends an M-PESA prompt through /charge with the draft reference", async () => {
			const { ctx, calls } = stand({
				"POST /charge": { reference: `dc-${DRAFT}`, status: "pay_offline" },
			});
			const result = await start(ctx, input(), credentials);
			expect(result).toEqual({ paymentReference: `dc-${DRAFT}`, status: "pending" });
			expect(calls).toHaveLength(1);
			expect(calls[0]?.body).toEqual({
				email: "till@example.com",
				amount: 160000,
				currency: "KES",
				reference: `dc-${DRAFT}`,
				metadata: { orderDraftId: DRAFT, channel: "in_person" },
				mobile_money: { phone: "+254712345678", provider: "mpesa" },
			});
		});

		it("reports a charge Paystack refuses at once", async () => {
			const { ctx } = stand({
				"POST /charge": { reference: `dc-${DRAFT}`, status: "failed", message: "Invalid number" },
			});
			const result = await start(ctx, input(), credentials);
			expect(result).toMatchObject({ status: "failed", reason: "Invalid number" });
		});

		it("takes phone prompts in KES only for now", async () => {
			const { ctx, calls } = stand({});
			await expect(start(ctx, input({ currency: "GHS" }), credentials)).rejects.toThrow(/KES/);
			expect(calls).toHaveLength(0);
		});
	});

	describe("terminal", () => {
		const terminalRoutes = {
			"POST /customer": { customer_code: "CUS_counter" },
			"POST /paymentrequest": {
				id: 7895939,
				request_code: "PRQ_counter1",
				offline_reference: "4634337895939",
			},
			"POST /terminal/TERM_front/event": {},
		};

		it("creates a payment request and pushes it to the chosen terminal", async () => {
			const { ctx, calls } = stand(terminalRoutes);
			const result = await start(
				ctx,
				input({ currency: "NGN", method: { type: "terminal", terminalId: "TERM_front" } }),
				credentials,
			);
			expect(result).toEqual({ paymentReference: "PRQ_counter1", status: "pending" });
			expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
				"POST /customer",
				"POST /paymentrequest",
				"POST /terminal/TERM_front/event",
			]);
			expect(calls[1]?.body).toMatchObject({
				customer: "CUS_counter",
				amount: 160000,
				currency: "NGN",
				send_notification: false,
			});
			// Carried back on paymentrequest.success.
			expect(JSON.parse(String(calls[1]?.body?.metadata))).toEqual({
				orderDraftId: DRAFT,
				channel: "in_person",
			});
			expect(calls[2]?.body).toEqual({
				type: "invoice",
				action: "process",
				data: { id: 7895939, reference: "4634337895939" },
			});
		});

		it("refuses currencies payment requests don't take, before calling Paystack", async () => {
			const { ctx, calls } = stand(terminalRoutes);
			const err = await start(
				ctx,
				input({ method: { type: "terminal", terminalId: "TERM_front" } }),
				credentials,
			).catch((e: unknown) => e);
			expect(isCurrencyNotSupportedError(err)).toBe(true);
			expect(calls).toHaveLength(0);
		});

		it("lists terminals by their terminal id", async () => {
			const { ctx } = stand({
				"GET /terminal": [
					{ terminal_id: "TERM_front", name: "Front till", serial_number: "S1" },
					{ terminal_id: "TERM_back", name: null, serial_number: "S2" },
					{ name: "No id" },
				],
			});
			const list = paystackPaymentProvider.listTerminals as NonNullable<
				typeof paystackPaymentProvider.listTerminals
			>;
			expect(await list(ctx, credentials)).toEqual([
				{ id: "TERM_front", name: "Front till" },
				{ id: "TERM_back", name: "S2" },
			]);
		});

		it("confirms a terminal payment through /paymentrequest/verify", async () => {
			const status = paystackPaymentProvider.getPaymentStatus as NonNullable<
				typeof paystackPaymentProvider.getPaymentStatus
			>;
			const paid = stand({
				"GET /paymentrequest/verify/PRQ_counter1": {
					status: "success",
					paid: true,
					amount: 160000,
					currency: "ngn",
				},
			});
			expect(await status(paid.ctx, "PRQ_counter1", credentials)).toEqual({
				status: "succeeded",
				paymentReference: "PRQ_counter1",
				amount: 160000,
				currency: "NGN",
			});
			const waiting = stand({
				"GET /paymentrequest/verify/PRQ_counter1": { status: "pending", paid: false },
			});
			expect((await status(waiting.ctx, "PRQ_counter1", credentials)).status).toBe("pending");
		});

		it("sends terminal refunds to the Paystack dashboard", async () => {
			const { ctx, calls } = stand({});
			await expect(
				paystackPaymentProvider.refund(
					ctx,
					{ paymentReference: "PRQ_counter1", refundRequestId: "rr1", currency: "NGN" },
					credentials,
				),
			).rejects.toThrow(/dashboard/);
			expect(calls).toHaveLength(0);
		});
	});

	describe("paymentrequest.success webhook", () => {
		const parse = (data: unknown) =>
			paystackPaymentProvider.parseWebhookEvent(
				JSON.stringify({ event: "paymentrequest.success", data }),
			);

		it("becomes a charge for the counter draft, keyed by the request code", () => {
			const event = parse({
				id: 7895939,
				request_code: "PRQ_counter1",
				status: "success",
				paid: true,
				amount: 160000,
				currency: "ngn",
				metadata: JSON.stringify({ orderDraftId: DRAFT }),
				customer: { email: "till@example.com", customer_code: "CUS_counter" },
			});
			expect(event).toMatchObject({
				type: "charge.succeeded",
				orderDraftId: DRAFT,
				providerId: "paystack",
				providerEventId: "paymentrequest.success:PRQ_counter1",
				paymentReference: "PRQ_counter1",
				amount: 160000,
				currency: "NGN",
				customer: { email: "till@example.com" },
			});
		});

		it("reads metadata as an object, a numeric-string amount and a numeric customer", () => {
			expect(
				parse({
					request_code: "PRQ_counter1",
					amount: "160000",
					currency: "NGN",
					metadata: { orderDraftId: DRAFT },
					customer: 28958104,
				}),
			).toMatchObject({ type: "charge.succeeded", amount: 160000, customer: { email: "" } });
		});

		it("falls back to the draft in the description this package writes", () => {
			expect(
				parse({
					request_code: "PRQ_counter1",
					amount: 160000,
					currency: "NGN",
					metadata: null,
					description: `Counter sale, order draft ${DRAFT}`,
				}),
			).toMatchObject({ type: "charge.succeeded", orderDraftId: DRAFT });
		});

		it("leaves a request it didn't create unhandled", () => {
			expect(
				parse({ request_code: "PRQ_other", amount: 5000, currency: "NGN", metadata: null }).type,
			).toBe("unhandled");
			expect(parse({ amount: 5000, currency: "NGN", metadata: { orderDraftId: DRAFT } }).type).toBe(
				"unhandled",
			);
		});
	});
});
