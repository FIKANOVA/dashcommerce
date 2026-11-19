/**
 * First-run payment setup (FIK-59).
 *
 * "Set up" means the active provider can take payments:
 *
 * - Stripe with both secret and webhook keys saved counts as set up, so
 *   existing stores never see the setup screen.
 * - Another provider with `checkConnection` is set up once a check has
 *   passed since its keys were last saved.
 * - A provider without `checkConnection` is set up once both keys are saved.
 *
 * KV: `setup:keysSavedAt:<providerId>` (ms, written by the settings API when
 * that provider's credentials change) and `setup:payments`
 * (`{ providerId, checkedAt }`, written by a passing check). Nothing derived
 * from a secret is stored.
 */

import type { PluginContext, RouteContext } from "emdash";
import {
	DEFAULT_PAYMENT_PROVIDER_ID,
	getPaymentProvider,
	listPaymentProviders,
	loadPaymentProviderCredentials,
	type PaymentProvider,
	providerCheckoutStyles,
} from "../payment-provider";
import { MASKED_SECRET_PREFIX } from "../settings/schema";

export const SETUP_PAYMENTS_KEY = "setup:payments";

export function keysSavedAtKey(providerId: string): string {
	return `setup:keysSavedAt:${providerId}`;
}

interface SetupCheckRecord {
	providerId: string;
	checkedAt: number;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function getCtx(routeCtx: RouteContext, ctx?: PluginContext): PluginContext {
	return (ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
}

async function activeProviderId(ctx: PluginContext): Promise<string> {
	return (await ctx.kv.get<string>("settings:paymentProvider")) ?? DEFAULT_PAYMENT_PROVIDER_ID;
}

/** Whether the active provider can take payments (see the module comment). */
export async function isPaymentSetUp(ctx: PluginContext): Promise<boolean> {
	const providerId = await activeProviderId(ctx);
	const provider = getPaymentProvider(providerId);
	if (!provider) return false;
	const creds = await loadPaymentProviderCredentials(ctx.kv, providerId);
	const keysSaved = Boolean(creds?.secretKey && creds.webhookSecret);
	if (!keysSaved) return false;
	if (providerId === "stripe" || !provider.checkConnection) return true;

	const check = await ctx.kv.get<SetupCheckRecord>(SETUP_PAYMENTS_KEY);
	if (!check || check.providerId !== providerId) return false;
	const keysSavedAt = (await ctx.kv.get<number>(keysSavedAtKey(providerId))) ?? 0;
	return check.checkedAt >= keysSavedAt;
}

function secretHint(value: string): string {
	return value.length < 4 ? MASKED_SECRET_PREFIX : `${MASKED_SECRET_PREFIX}${value.slice(-4)}`;
}

async function secretStatus(ctx: PluginContext, key: string) {
	const v = await ctx.kv.get<string>(`settings:${key}`);
	const isSet = typeof v === "string" && v.length > 0;
	return { isSet, hint: isSet ? secretHint(v) : null };
}

function credentialKeys(providerId: string): [string, string] {
	return providerId === "stripe"
		? ["stripeSecretKey", "stripeWebhookSecret"]
		: [`${providerId}SecretKey`, `${providerId}WebhookSecret`];
}

async function providerRow(ctx: PluginContext, provider: PaymentProvider, currency: string) {
	const [secretKey, webhookSecret] = credentialKeys(provider.id);
	return {
		id: provider.id,
		label: provider.label,
		description: provider.description ?? null,
		checkoutStyles: providerCheckoutStyles(provider),
		supportsDefaultCurrency: provider.supportsCurrency(currency),
		canCheckConnection: typeof provider.checkConnection === "function",
		credentialFields: provider.credentialFields ?? {},
		secrets: {
			secretKey: await secretStatus(ctx, secretKey),
			webhookSecret: await secretStatus(ctx, webhookSecret),
		},
	};
}

/** Public webhook URL for a provider, or just the path if the site URL is unknown. */
function webhookUrl(ctx: PluginContext, providerId: string): string {
	const path = `/_emdash/api/plugins/${ctx.plugin?.id ?? "dashcommerce"}/checkout/webhook?provider=${encodeURIComponent(providerId)}`;
	const site = ctx.site?.url?.replace(/\/$/, "");
	return site ? `${site}${path}` : path;
}

export const setupRoutes = {
	"admin/setup/status": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			const providerId = await activeProviderId(ctx);
			const currency = (await ctx.kv.get<string>("settings:defaultCurrency")) ?? "USD";
			const providers = [];
			for (const provider of listPaymentProviders()) {
				const row = await providerRow(ctx, provider, currency);
				if (provider.id === "stripe") providers.unshift(row);
				else providers.push(row);
			}
			return json({
				setUp: await isPaymentSetUp(ctx),
				activeProviderId: providerId,
				checkoutMode: (await ctx.kv.get<string>("settings:checkoutMode")) ?? "hosted",
				defaultCurrency: currency,
				webhookUrl: webhookUrl(ctx, providerId),
				providers,
			});
		},
	},

	"admin/setup/check": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			const requested = (routeCtx.input as { providerId?: unknown } | undefined)?.providerId;
			const providerId =
				typeof requested === "string" && requested ? requested : await activeProviderId(ctx);
			const provider = getPaymentProvider(providerId);
			if (!provider) {
				return json(
					{ ok: false, providerId, detail: `Payment provider "${providerId}" is not registered` },
					400,
				);
			}
			const creds = await loadPaymentProviderCredentials(ctx.kv, providerId);
			if (!creds?.secretKey) {
				return json({ ok: false, providerId, detail: "Save the secret key first" }, 400);
			}
			if (!provider.checkConnection) {
				return json({
					ok: true,
					providerId,
					skipped: true,
					detail: `${provider.label} has no connection check`,
				});
			}
			let result: { ok: boolean; detail?: string };
			try {
				result = await provider.checkConnection(ctx, creds);
			} catch (err) {
				result = { ok: false, detail: err instanceof Error ? err.message : String(err) };
			}
			if (result.ok) {
				await ctx.kv.set(SETUP_PAYMENTS_KEY, {
					providerId,
					checkedAt: Date.now(),
				} satisfies SetupCheckRecord);
			}
			return json({
				ok: result.ok,
				providerId,
				...(result.detail ? { detail: result.detail } : {}),
			});
		},
	},
};
