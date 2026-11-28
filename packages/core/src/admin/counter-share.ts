/**
 * "Pay on their phone": the message and links staff use to send a counter
 * sale's payment link from their own phone. Nothing here sends anything;
 * each link opens WhatsApp or the SMS app with the message filled in, and
 * staff tap send. The message holds only the total, the shop's name and the
 * link, plus the customer's number when staff typed one.
 */

import { format as formatMoney, type Money } from "../money";

export interface ShareInput {
	url: string;
	total: Money;
	shopName: string;
	/** As staff typed it; used only to address the message. */
	customerPhone?: string;
}

export function shareMessage(input: ShareInput): string {
	const shop = input.shopName.trim();
	const where = shop ? ` at ${shop}` : "";
	return `Pay ${formatMoney(input.total)} for your purchase${where}: ${input.url}`;
}

/**
 * The digits WhatsApp's `wa.me` link needs: an international number with
 * its country code and no `+`. A national number (leading 0) gives none, so
 * WhatsApp asks whom to send it to rather than guessing the country.
 */
export function whatsAppNumber(phone: string | undefined): string | undefined {
	if (!phone) return undefined;
	const compact = phone.replace(/[\s().-]/g, "");
	if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact.slice(1);
	if (/^00[1-9]\d{7,14}$/.test(compact)) return compact.slice(2);
	if (/^[1-9]\d{10,14}$/.test(compact)) return compact;
	return undefined;
}

export function whatsAppLink(input: ShareInput): string {
	const number = whatsAppNumber(input.customerPhone);
	return `https://wa.me/${number ?? ""}?text=${encodeURIComponent(shareMessage(input))}`;
}

/** `sms:` with the number (any form the phone can dial) and the message. */
export function smsLink(input: ShareInput): string {
	const compact = input.customerPhone?.replace(/[\s().-]/g, "") ?? "";
	const number = /^\+?\d{6,15}$/.test(compact) ? compact : "";
	// `?&body=` is read by both Android and iOS messaging apps.
	return `sms:${encodeURIComponent(number).replace(/%2B/g, "+")}?&body=${encodeURIComponent(shareMessage(input))}`;
}
