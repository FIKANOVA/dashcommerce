/**
 * Pesapal v3.0 API Types and Interfaces for @dashcommerce/pesapal
 */

export interface PesapalCredentials {
	/** Pesapal 3.0 Consumer Key */
	consumerKey: string;
	/** Pesapal 3.0 Consumer Secret */
	consumerSecret: string;
	/** Registered IPN ID (Notification ID) */
	ipnId?: string;
	/** Environment mode: sandbox or live (default: 'sandbox') */
	environment?: "sandbox" | "live";
	/** Custom base URL override (optional) */
	baseUrl?: string;
	/** Return URL after payment completes */
	callbackUrl?: string;
}

export interface PesapalAuthTokenResponse {
	token: string;
	expiryDate: string;
	error: string | null;
	status: string;
	message: string;
}

export interface PesapalSubmitOrderRequest {
	id: string; // Merchant reference (checkoutReference)
	currency: string;
	amount: number; // Major units (e.g. 1500 for KES 1,500)
	description: string;
	callback_url: string;
	notification_id: string;
	cancellation_url?: string;
	billing_address?: {
		email_address?: string;
		phone_number?: string;
		country_code?: string;
		first_name?: string;
		middle_name?: string;
		last_name?: string;
		line_1?: string;
		line_2?: string;
		city?: string;
		state?: string;
		postal_code?: string;
		zip_code?: string;
	};
}

export interface PesapalSubmitOrderResponse {
	order_tracking_id: string;
	merchant_reference: string;
	redirect_url: string;
	error: string | null;
	status: string;
}

export interface PesapalTransactionStatusResponse {
	payment_method: string;
	amount: number;
	created_date: string;
	confirmation_code: string;
	order_tracking_id: string;
	payment_status_description: "Completed" | "Failed" | "Reversed" | "Invalid";
	description: string;
	message: string;
	payment_account: string;
	call_back_url: string;
	status_code: number; // 1 = Completed, 2 = Failed, 3 = Reversed, 0 = Invalid
	merchant_reference: string;
	payment_status_code: string;
	currency: string;
	error: {
		error_type: string | null;
		code: string | null;
		message: string | null;
	} | null;
	status: string;
}

export interface PesapalRefundRequest {
	confirmation_code: string;
	amount: number;
	username: string;
	remarks: string;
}

export interface PesapalRefundResponse {
	status: string;
	message: string;
	refund_tracking_id?: string;
	error?: unknown;
}
