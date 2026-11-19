/**
 * Settings › Payments (FIK-59, design A): choose a payment provider and set
 * it up in four steps — keys, webhook URL, how customers pay, connection
 * test. Shown when more than one provider is registered; a store with only
 * Stripe keeps the classic Stripe card.
 *
 * Values go through the Settings page's draft and Save bar like every other
 * field. The connection test uses saved keys, so it asks for a save first.
 */

import { useCallback, useEffect, useState } from "react";
import { Alert, usePluginAPI } from "../kit";

interface SecretMeta {
	isSet: boolean;
	hint: string | null;
}

interface CredentialField {
	label?: string;
	prefixes?: string[];
	help?: string;
}

interface ProviderRow {
	id: string;
	label: string;
	description: string | null;
	logo: string | null;
	brandColour: string | null;
	highlights: string[];
	webhookUrl: string;
	checkoutStyles: Array<"hosted" | "on_page">;
	supportsDefaultCurrency: boolean;
	canCheckConnection: boolean;
	credentialFields: { secretKey?: CredentialField; webhookSecret?: CredentialField };
	secrets: { secretKey: SecretMeta; webhookSecret: SecretMeta };
}

interface SetupStatus {
	setUp: boolean;
	chosenProviderId: string | null;
	checkoutMode: string;
	defaultCurrency: string;
	providers: ProviderRow[];
}

export interface PaymentProvidersSectionProps {
	/** The value of a setting including unsaved edits. */
	getValue: (key: string) => unknown;
	setField: (key: string, value: unknown) => void;
	errors: Record<string, string>;
	disabled: boolean;
	/** True while the page has unsaved changes. */
	dirty: boolean;
	/** Changes after every save, to refetch the status. */
	refreshKey: number;
	/** Secrets status for Stripe's fixed keys (from GET admin/settings). */
	stripeSecrets: Record<string, SecretMeta>;
}

const ACCENT = "#2563eb";
const TEXT = "#111827";
const MUTED = "#4b5563";
const BORDER = "#d1d5db";

const stepNum: React.CSSProperties = {
	width: 28,
	height: 28,
	borderRadius: 999,
	background: "#eff6ff",
	color: "#1d4ed8",
	fontWeight: 700,
	fontSize: 14,
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
};
const stepRow: React.CSSProperties = {
	display: "grid",
	gridTemplateColumns: "32px minmax(0, 1fr)",
	gap: 16,
};
const stepTitle: React.CSSProperties = { margin: 0, fontSize: 16, fontWeight: 600, color: TEXT };
const inputStyle: React.CSSProperties = {
	height: 44,
	boxSizing: "border-box",
	padding: "0 12px",
	border: `1px solid ${BORDER}`,
	borderRadius: 8,
	font: "inherit",
	fontSize: 15,
	width: "100%",
};
const help: React.CSSProperties = { fontSize: 13, color: MUTED };

/** Hidden but focusable, so the native radio still drives keyboard and screen readers. */
const srOnly: React.CSSProperties = {
	position: "absolute",
	width: 1,
	height: 1,
	margin: -1,
	overflow: "hidden",
	clip: "rect(0 0 0 0)",
	whiteSpace: "nowrap",
	border: 0,
};

const fieldsetReset: React.CSSProperties = { border: 0, margin: 0, padding: 0, minWidth: 0 };

function choiceStyle(on: boolean, focused = false): React.CSSProperties {
	return {
		position: "relative",
		outline: focused ? `3px solid ${ACCENT}` : "none",
		outlineOffset: 2,
		display: "flex",
		flexDirection: "column",
		gap: 8,
		padding: 16,
		textAlign: "left",
		cursor: "pointer",
		font: "inherit",
		borderRadius: 12,
		background: on ? "#f8fbff" : "#ffffff",
		border: on ? `2px solid ${ACCENT}` : `1px solid ${BORDER}`,
	};
}

function Logo({ row }: { row: ProviderRow }) {
	if (row.logo) {
		return (
			<img
				src={row.logo}
				alt={`${row.label} logo`}
				style={{ width: 48, height: 48, borderRadius: 12, objectFit: "contain", flex: "none" }}
			/>
		);
	}
	return (
		<div
			aria-hidden="true"
			style={{
				width: 48,
				height: 48,
				borderRadius: 12,
				flex: "none",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				fontSize: 22,
				fontWeight: 700,
				color: "#ffffff",
				background: row.brandColour ?? "#475569",
			}}
		>
			{row.label.charAt(0).toUpperCase()}
		</div>
	);
}

/** Field specs for a provider's credentials, Stripe's fixed keys included. */
function credentialInputs(row: ProviderRow) {
	if (row.id === "stripe") {
		return [
			{
				key: "stripeSecretKey",
				secret: true,
				label: "Secret key",
				placeholder: "sk_test_…",
				help: "Test keys start with sk_test_. Never shown to customers.",
			},
			{
				key: "stripePublishableKey",
				secret: false,
				label: "Publishable key",
				placeholder: "pk_test_…",
				help: "Needed for on-page checkout. Safe to show in the storefront.",
			},
			{
				key: "stripeWebhookSecret",
				secret: true,
				label: "Webhook signing secret",
				placeholder: "whsec_…",
				help: "From Developers › Webhooks, or the `stripe listen` output.",
			},
		];
	}
	const field = (name: "secretKey" | "webhookSecret", fallback: string) => {
		const spec = row.credentialFields[name] ?? {};
		const prefixes = spec.prefixes?.length ? `Starts with ${spec.prefixes.join(" or ")}. ` : "";
		return {
			key: `${row.id}${name === "secretKey" ? "SecretKey" : "WebhookSecret"}`,
			secret: true,
			label: spec.label ?? `${row.label} ${fallback}`,
			placeholder: spec.prefixes?.length ? `${spec.prefixes[0]}…` : "",
			help: `${prefixes}${spec.help ?? ""}`.trim(),
			meta: row.secrets[name],
		};
	};
	return [field("secretKey", "secret key"), field("webhookSecret", "webhook secret")];
}

export function PaymentProvidersSection(props: PaymentProvidersSectionProps) {
	const { getValue, setField, errors, disabled, dirty, refreshKey, stripeSecrets } = props;
	const api = usePluginAPI();
	const [status, setStatus] = useState<SetupStatus | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [checking, setChecking] = useState(false);
	const [check, setCheck] = useState<{ ok: boolean; detail?: string } | null>(null);
	const [focused, setFocused] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setStatus(await api.get<SetupStatus>("admin/setup/status"));
			setLoadError(null);
		} catch (err) {
			setLoadError(err instanceof Error ? err.message : "Could not load payment providers");
		}
	}, [api]);

	useEffect(() => {
		void refreshKey;
		load();
	}, [load, refreshKey]);

	if (loadError) {
		return (
			<Alert type="error" title="Could not load payment providers">
				{loadError}
			</Alert>
		);
	}
	if (!status) return <p style={help}>Loading payment providers…</p>;

	const draftChoice = getValue("paymentProvider") as string | null | undefined;
	const selectedId = draftChoice ?? status.chosenProviderId;
	const selected = status.providers.find((p) => p.id === selectedId) ?? null;
	const checkoutMode =
		(getValue("checkoutMode") as string | null | undefined) ?? status.checkoutMode;
	const style: "hosted" | "on_page" = checkoutMode === "embedded" ? "on_page" : "hosted";
	const secretKeySaved =
		selected?.id === "stripe"
			? Boolean(stripeSecrets.stripeSecretKey?.isSet)
			: Boolean(selected?.secrets.secretKey.isSet);

	function choose(id: string) {
		setField("paymentProvider", id);
		setCheck(null);
		setCopied(false);
		const row = status?.providers.find((p) => p.id === id);
		// Keep the checkout flow valid for the new provider.
		if (row && style === "on_page" && !row.checkoutStyles.includes("on_page")) {
			setField("checkoutMode", "hosted");
		}
	}

	async function runCheck() {
		if (!selected) return;
		setChecking(true);
		setCheck(null);
		try {
			const r = await api.post<{ ok: boolean; detail?: string }>("admin/setup/check", {
				providerId: selected.id,
			});
			setCheck(r);
			if (r.ok) await load();
		} catch (err) {
			const body = (err as { body?: { detail?: string; error?: string } }).body;
			setCheck({
				ok: false,
				detail:
					body?.detail ?? body?.error ?? (err instanceof Error ? err.message : "Check failed"),
			});
		} finally {
			setChecking(false);
		}
	}

	async function copyUrl(url: string) {
		try {
			await navigator.clipboard.writeText(url);
			setCopied(true);
		} catch {
			setCopied(false);
		}
	}

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
			{!status.setUp && (
				<Alert type="warning" title="Payments aren't set up yet">
					{selected
						? `Finish the steps below to start taking payments with ${selected.label}.`
						: "Choose a provider below. Customers can't check out until one is connected."}
				</Alert>
			)}

			<fieldset style={fieldsetReset}>
				<legend style={srOnly}>Payment provider</legend>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
						gap: 16,
					}}
				>
					{status.providers.map((row) => {
						const on = row.id === selectedId;
						const isSetUp = on && status.setUp && !dirty;
						return (
							<label
								key={row.id}
								style={{
									position: "relative",
									outline: focused === `p-${row.id}` ? `3px solid ${ACCENT}` : "none",
									outlineOffset: 2,
									display: "flex",
									flexDirection: "column",
									alignItems: "stretch",
									gap: 14,
									padding: 20,
									textAlign: "left",
									cursor: "pointer",
									font: "inherit",
									borderRadius: 12,
									background: on ? "#f8fbff" : "#ffffff",
									border: on ? `2px solid ${ACCENT}` : `1px solid ${BORDER}`,
									boxShadow: on ? "0 0 0 4px rgba(37,99,235,0.10)" : "none",
								}}
							>
								<input
									type="radio"
									name="dashcommerce-payment-provider"
									value={row.id}
									checked={on}
									disabled={disabled}
									onChange={() => choose(row.id)}
									onFocus={() => setFocused(`p-${row.id}`)}
									onBlur={() => setFocused(null)}
									style={srOnly}
								/>
								<span style={{ display: "flex", alignItems: "center", gap: 14 }}>
									<Logo row={row} />
									<span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
										<span style={{ fontSize: 17, fontWeight: 600, color: TEXT }}>{row.label}</span>
										{!row.supportsDefaultCurrency && (
											<span style={{ fontSize: 13, color: "#b45309" }}>
												Doesn't support {status.defaultCurrency}
											</span>
										)}
									</span>
									{isSetUp && (
										<span
											style={{
												fontSize: 12,
												fontWeight: 600,
												color: "#166534",
												background: "#dcfce7",
												borderRadius: 999,
												padding: "4px 10px",
											}}
										>
											Active
										</span>
									)}
									{on && (
										<svg
											aria-hidden="true"
											width="24"
											height="24"
											viewBox="0 0 24 24"
											fill={ACCENT}
										>
											<circle cx="12" cy="12" r="11" />
											<path
												d="M7 12.5l3.2 3.2L17 9"
												fill="none"
												stroke="#ffffff"
												strokeWidth="2.4"
												strokeLinecap="round"
												strokeLinejoin="round"
											/>
										</svg>
									)}
								</span>
								{row.description && (
									<span style={{ fontSize: 14, color: "#374151", lineHeight: 1.5 }}>
										{row.description}
									</span>
								)}
								<span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
									{[
										...row.highlights,
										row.checkoutStyles.includes("on_page") ? "Hosted or on-page" : "Hosted page",
									].map((chip) => (
										<span
											key={chip}
											style={{
												fontSize: 12,
												fontWeight: 500,
												color: "#334155",
												background: "#f1f5f9",
												borderRadius: 6,
												padding: "4px 8px",
											}}
										>
											{chip}
										</span>
									))}
								</span>
							</label>
						);
					})}
				</div>
			</fieldset>

			{!selected && (
				<p style={{ margin: 0, ...help, fontSize: 14 }}>
					Pick a provider to set it up. Nothing is charged until you finish.
				</p>
			)}

			{selected && (
				<div
					style={{
						borderTop: "1px solid #e5e7eb",
						paddingTop: 24,
						display: "flex",
						flexDirection: "column",
						gap: 28,
					}}
				>
					<div style={stepRow}>
						<span style={stepNum}>1</span>
						<div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 560 }}>
							<h3 style={stepTitle}>Add your {selected.label} keys</h3>
							{credentialInputs(selected).map((f) => {
								const meta = "meta" in f ? f.meta : stripeSecrets[f.key];
								const raw = getValue(f.key);
								const value = typeof raw === "string" ? raw : "";
								const id = `pay-${f.key}`;
								return (
									<div key={f.key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
										<label htmlFor={id} style={{ fontSize: 14, fontWeight: 500, color: "#1f2937" }}>
											{f.label}
										</label>
										<input
											id={id}
											type={f.secret ? "password" : "text"}
											value={value}
											autoComplete={f.secret ? "new-password" : "off"}
											placeholder={f.secret && meta?.isSet ? (meta.hint ?? "••••") : f.placeholder}
											disabled={disabled}
											aria-invalid={errors[f.key] ? true : undefined}
											onChange={(e) => {
												const next = e.currentTarget.value;
												setField(f.key, next === "" ? undefined : next);
											}}
											style={{ ...inputStyle, borderColor: errors[f.key] ? "#b91c1c" : BORDER }}
										/>
										<span style={errors[f.key] ? { ...help, color: "#b91c1c" } : help}>
											{errors[f.key] ??
												(f.secret && meta?.isSet
													? `Saved (${meta.hint}). Leave blank to keep it.`
													: f.help)}
										</span>
									</div>
								);
							})}
						</div>
					</div>

					<div style={stepRow}>
						<span style={stepNum}>2</span>
						<div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 760 }}>
							<h3 style={stepTitle}>Point {selected.label}'s webhooks here</h3>
							<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
								<input
									readOnly
									aria-label="Webhook URL"
									value={selected.webhookUrl}
									onFocus={(e) => e.currentTarget.select()}
									style={{
										...inputStyle,
										flex: "1 1 260px",
										width: "auto",
										minWidth: 0,
										background: "#f9fafb",
										fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
										fontSize: 13,
									}}
								/>
								<button
									type="button"
									onClick={() => copyUrl(selected.webhookUrl)}
									style={{
										height: 44,
										padding: "0 16px",
										border: `1px solid ${BORDER}`,
										borderRadius: 8,
										background: "#ffffff",
										font: "inherit",
										fontSize: 14,
										fontWeight: 600,
										color: "#1f2937",
										cursor: "pointer",
									}}
								>
									{copied ? "Copied" : "Copy"}
								</button>
							</div>
							<span style={help}>
								Add this as the webhook endpoint in your {selected.label} dashboard (test mode while
								testing).
							</span>
						</div>
					</div>

					<div style={stepRow}>
						<span style={stepNum}>3</span>
						<div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 760 }}>
							<h3 style={stepTitle}>How customers pay</h3>
							<fieldset
								style={{
									...fieldsetReset,
									display: "grid",
									gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
									gap: 12,
								}}
							>
								<legend style={srOnly}>How customers pay</legend>
								<label style={choiceStyle(style === "hosted", focused === "s-hosted")}>
									<input
										type="radio"
										name="dashcommerce-checkout-style"
										value="hosted"
										checked={style === "hosted"}
										disabled={disabled}
										onChange={() => setField("checkoutMode", "hosted")}
										onFocus={() => setFocused("s-hosted")}
										onBlur={() => setFocused(null)}
										style={srOnly}
									/>
									<span style={{ fontSize: 15, fontWeight: 600, color: TEXT }}>Hosted page</span>
									<span style={{ fontSize: 13, color: MUTED, lineHeight: 1.45 }}>
										Customers go to {selected.label} to pay, then come back to your store.
									</span>
								</label>
								{selected.checkoutStyles.includes("on_page") && (
									<label style={choiceStyle(style === "on_page", focused === "s-on_page")}>
										<input
											type="radio"
											name="dashcommerce-checkout-style"
											value="on_page"
											checked={style === "on_page"}
											disabled={disabled}
											onChange={() => setField("checkoutMode", "embedded")}
											onFocus={() => setFocused("s-on_page")}
											onBlur={() => setFocused(null)}
											style={srOnly}
										/>
										<span style={{ fontSize: 15, fontWeight: 600, color: TEXT }}>On your page</span>
										<span style={{ fontSize: 13, color: MUTED, lineHeight: 1.45 }}>
											{selected.id === "stripe"
												? "A card form appears in your checkout; customers never leave your store."
												: `${selected.label} opens over your checkout; customers never leave your store.`}
										</span>
									</label>
								)}
							</fieldset>
						</div>
					</div>

					<div style={stepRow}>
						<span style={stepNum}>4</span>
						<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
							<h3 style={stepTitle}>Test the connection</h3>
							{selected.canCheckConnection ? (
								<div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
									<button
										type="button"
										onClick={runCheck}
										disabled={disabled || dirty || checking || !secretKeySaved}
										style={{
											height: 44,
											padding: "0 18px",
											border: 0,
											borderRadius: 8,
											background: ACCENT,
											color: "#ffffff",
											font: "inherit",
											fontSize: 15,
											fontWeight: 600,
											cursor: "pointer",
											opacity: dirty || checking ? 0.6 : 1,
										}}
									>
										{checking ? "Testing…" : "Test connection"}
									</button>
									<output
										aria-live="polite"
										style={{
											fontSize: 14,
											fontWeight: check ? 500 : 400,
											color: check ? (check.ok ? "#166534" : "#b91c1c") : MUTED,
										}}
									>
										{dirty
											? "Save your changes first; the test uses saved keys."
											: check
												? check.ok
													? `Connected to ${selected.label}. ${check.detail ?? ""}`.trim()
													: `Couldn't connect: ${check.detail ?? "unknown error"}`
												: `Checks your keys with ${selected.label}. Nothing is charged.`}
									</output>
								</div>
							) : (
								<span style={help}>
									{selected.label} has no connection test. It's ready once both keys are saved.
								</span>
							)}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
