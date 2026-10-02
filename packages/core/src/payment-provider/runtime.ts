/**
 * Runtime adapter utilities for PaymentProvider.
 * Converts PluginContext / RouteContext to PaymentProviderRuntimeContext.
 */

import type { PaymentProviderRuntimeContext } from "./types";

export interface LogLike {
	info: (msg: string, meta?: Record<string, unknown>) => void;
	warn: (msg: string, meta?: Record<string, unknown>) => void;
	error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface HttpLike {
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

export function toPaymentProviderRuntimeContext(ctx: {
	http?: HttpLike;
	log: LogLike;
}): PaymentProviderRuntimeContext {
	const customFetch = ctx.http?.fetch;
	const runtimeFetch: typeof fetch = (input, init) => {
		if (customFetch) {
			const url = typeof input === "string" ? input : input.toString();
			return customFetch(url, init);
		}
		return fetch(input, init);
	};
	return {
		http: { fetch: runtimeFetch },
		log: ctx.log,
	};
}
