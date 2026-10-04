/**
 * Pesapal v3.0 REST API client with in-memory JWT token caching
 */

import type {
	PesapalAuthTokenResponse,
	PesapalCredentials,
	PesapalRefundRequest,
	PesapalRefundResponse,
	PesapalSubmitOrderRequest,
	PesapalSubmitOrderResponse,
	PesapalTransactionStatusResponse,
} from "./types";

const SANDBOX_BASE_URL = "https://cybqa.pesapal.com/pesapalv3";
const LIVE_BASE_URL = "https://pay.pesapal.com/v3";

interface CachedToken {
	token: string;
	expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

export function getBaseUrl(credentials: PesapalCredentials): string {
	if (credentials.baseUrl) return credentials.baseUrl.replace(/\/+$/, "");
	return credentials.environment === "live" ? LIVE_BASE_URL : SANDBOX_BASE_URL;
}

export async function getAuthToken(
	credentials: PesapalCredentials,
	fetchFn: typeof fetch = fetch,
): Promise<string> {
	const cacheKey = `${credentials.consumerKey}:${credentials.environment ?? "sandbox"}`;
	const cached = tokenCache.get(cacheKey);
	const now = Date.now();

	if (cached && cached.expiresAt > now + 30_000) {
		return cached.token;
	}

	const baseUrl = getBaseUrl(credentials);
	const res = await fetchFn(`${baseUrl}/api/Auth/RequestToken`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			consumer_key: credentials.consumerKey,
			consumer_secret: credentials.consumerSecret,
		}),
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Pesapal authentication failed (${res.status}): ${text}`);
	}

	const data = (await res.json()) as PesapalAuthTokenResponse;
	if (!data.token) {
		throw new Error(`Pesapal authentication returned no token: ${data.message || data.error}`);
	}

	// Expiry date is typically ISO string e.g. "2026-10-04T18:50:00Z"
	const expiresAt = data.expiryDate ? new Date(data.expiryDate).getTime() : now + 5 * 60 * 1000;
	tokenCache.set(cacheKey, { token: data.token, expiresAt });

	return data.token;
}

export async function submitOrder(
	credentials: PesapalCredentials,
	token: string,
	req: PesapalSubmitOrderRequest,
	fetchFn: typeof fetch = fetch,
): Promise<PesapalSubmitOrderResponse> {
	const baseUrl = getBaseUrl(credentials);
	const res = await fetchFn(`${baseUrl}/api/Transactions/SubmitOrder`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(req),
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Pesapal SubmitOrder failed (${res.status}): ${text}`);
	}

	const data = (await res.json()) as PesapalSubmitOrderResponse;
	if (data.error) {
		throw new Error(`Pesapal SubmitOrder returned error: ${data.error}`);
	}

	return data;
}

export async function getTransactionStatus(
	credentials: PesapalCredentials,
	token: string,
	orderTrackingId: string,
	fetchFn: typeof fetch = fetch,
): Promise<PesapalTransactionStatusResponse> {
	const baseUrl = getBaseUrl(credentials);
	const url = `${baseUrl}/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}`;
	const res = await fetchFn(url, {
		method: "GET",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
		},
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Pesapal GetTransactionStatus failed (${res.status}): ${text}`);
	}

	return (await res.json()) as PesapalTransactionStatusResponse;
}

export async function requestRefund(
	credentials: PesapalCredentials,
	token: string,
	req: PesapalRefundRequest,
	fetchFn: typeof fetch = fetch,
): Promise<PesapalRefundResponse> {
	const baseUrl = getBaseUrl(credentials);
	const res = await fetchFn(`${baseUrl}/api/Transactions/RefundRequest`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(req),
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Pesapal RefundRequest failed (${res.status}): ${text}`);
	}

	return (await res.json()) as PesapalRefundResponse;
}

/** Clear token cache (useful for testing) */
export function clearTokenCache(): void {
	tokenCache.clear();
}
