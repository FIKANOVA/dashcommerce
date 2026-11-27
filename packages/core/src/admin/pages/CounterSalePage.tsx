/**
 * Counter sale — staff sell from the shop's products and stock in person.
 *
 * Staff add products (stock is held when the payment starts), choose how
 * the customer pays (a prompt on their phone, or a card terminal when the
 * provider lists one) and wait. The page checks every few seconds; the
 * order is created through the same path as an online order.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Input, Loading, Select, Table, confirm, usePluginAPI } from "../kit";
import { format as formatMoney, type Money } from "../../money";
import { T } from "../theme";

const POLL_MS = 3000;

interface Setup {
	available: boolean;
	message?: string;
	providerLabel?: string;
	currency: string;
	methods: Array<"phone" | "terminal">;
	terminals: Array<{ id: string; name: string }>;
	terminalMessage?: string;
}

interface ProductRow {
	productId: string;
	title: string;
	price: Money;
	stockQuantity: number | null;
}

interface Line extends ProductRow {
	quantity: number;
}

interface SaleState {
	orderDraftId: string;
	status: "pending" | "paid" | "failed";
	method: "phone" | "terminal";
	amount: number;
	currency: string;
	failure?: "declined" | "timed_out";
	reason?: string;
	orderId?: string;
	orderNumber?: string;
}

/** HTTP status of a failed admin API call, when it has one. */
function errorStatus(err: unknown): number | undefined {
	const status = (err as { status?: unknown } | null)?.status;
	return typeof status === "number" ? status : undefined;
}

/** A 4xx other than 409/429 won't change by asking again. */
function isPermanent(err: unknown): boolean {
	const status = errorStatus(err);
	return status !== undefined && status >= 400 && status < 500 && status !== 409 && status !== 429;
}

/**
 * Keep checking while the customer may still pay: a pending sale, or a
 * terminal sale that stopped waiting (a card can still be tapped late).
 */
function keepChecking(sale: SaleState): boolean {
	return sale.status === "pending" || (sale.status === "failed" && sale.method === "terminal");
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function failureText(sale: SaleState): string {
	if (sale.failure === "timed_out") return "Timed out. The customer didn't approve in time.";
	const where = sale.method === "phone" ? "Cancelled or declined on the phone" : "Cancelled or declined on the terminal";
	return sale.reason ? `${where}: ${sale.reason}` : `${where}.`;
}

export function CounterSalePage() {
	const api = usePluginAPI();
	const [setup, setSetup] = useState<Setup | null>(null);
	const [setupError, setSetupError] = useState<string | null>(null);

	const [query, setQuery] = useState("");
	const [results, setResults] = useState<ProductRow[]>([]);
	const [searching, setSearching] = useState(false);

	const [lines, setLines] = useState<Line[]>([]);
	const [method, setMethod] = useState<"phone" | "terminal">("phone");
	const [phone, setPhone] = useState("");
	const [terminalId, setTerminalId] = useState("");
	const [email, setEmail] = useState("");
	const [customerPhone, setCustomerPhone] = useState("");

	const [sale, setSale] = useState<SaleState | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [saleError, setSaleError] = useState<string | null>(null);
	/** A failed attempt the staff member went back to change; the next payment retries it. */
	const [changedFrom, setChangedFrom] = useState<string | null>(null);
	const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		api
			.get<Setup>("admin/counter/setup")
			.then((s) => {
				setSetup(s);
				if (s.methods[0]) setMethod(s.methods[0]);
				if (s.terminals[0]) setTerminalId(s.terminals[0].id);
			})
			.catch((err) => setSetupError(errorText(err)));
	}, [api]);

	// Debounced product search.
	useEffect(() => {
		if (!setup?.available) return;
		const controller = new AbortController();
		const timer = setTimeout(() => {
			setSearching(true);
			api
				.get<{ items: ProductRow[] }>(
					"admin/counter/products",
					{ q: query.trim() || undefined, currency: setup.currency },
					{ signal: controller.signal },
				)
				.then((r) => setResults(r.items))
				.catch(() => undefined)
				.finally(() => setSearching(false));
		}, 250);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [api, query, setup]);

	const stopPolling = useCallback(() => {
		if (pollTimer.current) clearTimeout(pollTimer.current);
		pollTimer.current = null;
	}, []);

	useEffect(() => stopPolling, [stopPolling]);

	const poll = useCallback(
		(orderDraftId: string) => {
			pollTimer.current = setTimeout(async () => {
				try {
					const next = await api.get<SaleState>("admin/counter/status", { draft: orderDraftId });
					setSale(next);
					if (keepChecking(next)) poll(orderDraftId);
				} catch (err) {
					if (isPermanent(err)) {
						setSaleError(`Stopped checking: ${errorText(err)}`);
						return;
					}
					// A dropped connection at the counter: keep checking.
					poll(orderDraftId);
				}
			}, POLL_MS);
		},
		[api],
	);

	function addProduct(row: ProductRow) {
		setLines((prev) => {
			const found = prev.find((l) => l.productId === row.productId);
			if (found) {
				return prev.map((l) => (l.productId === row.productId ? { ...l, quantity: l.quantity + 1 } : l));
			}
			return [...prev, { ...row, quantity: 1 }];
		});
	}

	function setQuantity(productId: string, quantity: number) {
		setLines((prev) =>
			quantity <= 0
				? prev.filter((l) => l.productId !== productId)
				: prev.map((l) => (l.productId === productId ? { ...l, quantity } : l)),
		);
	}

	async function takePayment() {
		setSaleError(null);
		setSubmitting(true);
		stopPolling();
		// Retry names the earlier attempt, so the server can check it was not
		// paid late before asking the customer again.
		const retryOf = sale?.status === "failed" ? sale.orderDraftId : (changedFrom ?? undefined);
		try {
			const started = await api.post<SaleState>("admin/counter/sale", {
				lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
				method: method === "phone" ? { type: "phone", phone } : { type: "terminal", terminalId },
				currency: setup?.currency,
				...(email.trim() ? { customerEmail: email.trim() } : {}),
				...(method === "terminal" && customerPhone.trim()
					? { customerPhone: customerPhone.trim() }
					: {}),
				...(retryOf ? { retryOf } : {}),
			});
			setSale(started);
			setChangedFrom(null);
			if (keepChecking(started)) poll(started.orderDraftId);
		} catch (err) {
			setSaleError(errorText(err));
			if (retryOf && errorStatus(err) === 409) {
				// The earlier attempt was paid late, or is still waiting: show it.
				try {
					const earlier = await api.get<SaleState>("admin/counter/status", { draft: retryOf });
					setSale(earlier);
					if (keepChecking(earlier)) poll(retryOf);
				} catch {
					// Keep the error shown above.
				}
			} else if (sale && keepChecking(sale)) {
				poll(sale.orderDraftId);
			}
		} finally {
			setSubmitting(false);
		}
	}

	async function newSale() {
		if (sale && keepChecking(sale)) {
			const leave = await confirm({
				title: "Start a new sale?",
				description:
					sale.status === "pending"
						? "This payment is still waiting for the customer. If they pay, the order is still created and appears in Orders, but this page stops showing it."
						: "A card can still be tapped on the terminal for this sale. If it is, the order is still created and appears in Orders, but this page stops showing it.",
				confirmLabel: "New sale",
				cancelLabel: "Keep waiting",
			});
			if (!leave) return;
		}
		stopPolling();
		setSale(null);
		setChangedFrom(null);
		setLines([]);
		setPhone("");
		setEmail("");
		setCustomerPhone("");
		setSaleError(null);
	}

	if (setupError) {
		return (
			<Card title="Counter sale">
				<Alert type="error" title="Counter sales are unavailable">
					{setupError}
				</Alert>
			</Card>
		);
	}
	if (!setup) return <Loading />;
	if (!setup.available) {
		return (
			<Card title="Counter sale">
				<Alert type="info" title="Counter sales are off">
					{setup.message}
				</Alert>
			</Card>
		);
	}

	const currency = setup.currency;
	const subtotal = lines.reduce((sum, l) => sum + l.price.amount * l.quantity, 0);
	const canPay =
		lines.length > 0 &&
		!submitting &&
		(method === "phone" ? phone.trim().length >= 9 : terminalId !== "");

	if (sale) {
		return (
			<Card title="Counter sale">
				<p style={{ fontSize: "1.2em", margin: "0 0 12px" }}>
					{formatMoney({ amount: sale.amount, currency: sale.currency })}
				</p>
				{sale.status === "pending" && (
					<Alert type="info" title="Waiting for the customer">
						{sale.method === "phone"
							? "Waiting for the customer to approve on their phone."
							: "Waiting for the customer to pay on the terminal."}
					</Alert>
				)}
				{sale.status === "paid" && (
					<Alert type="success" title={`Paid. Order ${sale.orderNumber ?? ""}`}>
						The order is in Orders as a counter sale.
					</Alert>
				)}
				{sale.status === "failed" && (
					<Alert type="error" title="Not paid">
						{failureText(sale)} The stock is no longer held.
						{sale.method === "terminal"
							? " Still checking in case the card is tapped late; check the terminal before you retry."
							: ""}
					</Alert>
				)}
				<div style={{ display: "flex", gap: 8, marginTop: 12 }}>
					{sale.status === "failed" && (
						<Button variant="primary" onClick={takePayment} disabled={submitting}>
							Retry
						</Button>
					)}
					{sale.status === "failed" && (
						<Button
							onClick={() => {
								stopPolling();
								setChangedFrom(sale.orderDraftId);
								setSale(null);
							}}
						>
							Change the sale
						</Button>
					)}
					{sale.status === "paid" && sale.orderId && (
						<Button
							onClick={() => {
								window.location.href = `./orders#/orders/${sale.orderId}`;
							}}
						>
							View order
						</Button>
					)}
					<Button variant={sale.status === "paid" ? "primary" : "secondary"} onClick={newSale}>
						New sale
					</Button>
				</div>
				{saleError && (
					<div style={{ marginTop: 12 }}>
						<Alert type="error" title="Couldn't start the payment">
							{saleError}
						</Alert>
					</div>
				)}
			</Card>
		);
	}

	return (
		<div style={{ display: "grid", gap: 16 }}>
			<Card title="Counter sale">
				<Input
					label="Find a product"
					placeholder="Product name"
					value={query}
					onChange={(e) => setQuery(e.currentTarget.value)}
				/>
				<div style={{ marginTop: 12 }}>
					{searching && results.length === 0 ? (
						<Loading label="Searching…" />
					) : results.length === 0 ? (
						<p style={{ color: T.textMuted }}>No products priced in {currency} match.</p>
					) : (
						<Table<ProductRow>
							data={results}
							getRowKey={(r) => r.productId}
							columns={[
								{ key: "title", header: "Product", render: (r) => r.title },
								{ key: "price", header: "Price", render: (r) => formatMoney(r.price) },
								{
									key: "stock",
									header: "In stock",
									render: (r) => (r.stockQuantity === null ? "—" : String(r.stockQuantity)),
								},
								{
									key: "add",
									header: "",
									render: (r) => (
										<Button size="sm" onClick={() => addProduct(r)}>
											Add
										</Button>
									),
								},
							]}
						/>
					)}
				</div>
			</Card>

			<Card title="This sale">
				{lines.length === 0 ? (
					<p style={{ color: T.textMuted }}>Add products to start.</p>
				) : (
					<Table<Line>
						data={lines}
						getRowKey={(l) => l.productId}
						columns={[
							{ key: "title", header: "Product", render: (l) => l.title },
							{
								key: "qty",
								header: "Quantity",
								render: (l) => (
									<div style={{ display: "flex", gap: 6, alignItems: "center" }}>
										<Button size="sm" aria-label={`One fewer ${l.title}`} onClick={() => setQuantity(l.productId, l.quantity - 1)}>
											−
										</Button>
										<span>{l.quantity}</span>
										<Button size="sm" aria-label={`One more ${l.title}`} onClick={() => setQuantity(l.productId, l.quantity + 1)}>
											+
										</Button>
									</div>
								),
							},
							{
								key: "total",
								header: "Line total",
								render: (l) => formatMoney({ amount: l.price.amount * l.quantity, currency }),
							},
						]}
					/>
				)}
				<p style={{ margin: "12px 0", fontWeight: 600 }}>
					Subtotal: {formatMoney({ amount: subtotal, currency })}
				</p>
				<p style={{ margin: "0 0 12px", color: T.textMuted, fontSize: 13 }}>
					Tax, if any, is added when the payment starts.
				</p>

				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
						gap: 12,
					}}
				>
					<Select
						label="Customer pays by"
						value={method}
						options={setup.methods.map((m) => ({
							value: m,
							label: m === "phone" ? "Phone (M-PESA prompt)" : "Card terminal",
						}))}
						onChange={(e) => setMethod(e.currentTarget.value as "phone" | "terminal")}
					/>
					{method === "phone" ? (
						<Input
							label="Customer's phone number"
							type="tel"
							inputMode="tel"
							placeholder="+254712345678"
							value={phone}
							onChange={(e) => setPhone(e.currentTarget.value)}
						/>
					) : (
						<>
							<Select
								label="Terminal"
								value={terminalId}
								options={setup.terminals.map((t) => ({ value: t.id, label: t.name }))}
								onChange={(e) => setTerminalId(e.currentTarget.value)}
							/>
							<Input
								label="Customer's phone number (optional)"
								type="tel"
								inputMode="tel"
								placeholder="+254712345678"
								value={customerPhone}
								onChange={(e) => setCustomerPhone(e.currentTarget.value)}
							/>
						</>
					)}
					<Input
						label="Customer's email for the receipt (optional)"
						type="email"
						value={email}
						onChange={(e) => setEmail(e.currentTarget.value)}
					/>
					{!email.trim() && (
						<p style={{ color: T.textMuted, fontSize: 13, margin: 0 }}>
							Without an email the sale is recorded as a walk-in customer and no receipt is sent.
						</p>
					)}
				</div>
				{setup.terminalMessage && (
					<p style={{ color: T.textMuted, fontSize: 13 }}>{setup.terminalMessage}</p>
				)}
				{saleError && (
					<div style={{ marginTop: 12 }}>
						<Alert type="error" title="Couldn't start the payment">
							{saleError}
						</Alert>
					</div>
				)}
				<div style={{ marginTop: 12 }}>
					<Button variant="primary" onClick={takePayment} disabled={!canPay}>
						{submitting ? "Starting…" : "Take payment"}
					</Button>
				</div>
			</Card>
		</div>
	);
}
