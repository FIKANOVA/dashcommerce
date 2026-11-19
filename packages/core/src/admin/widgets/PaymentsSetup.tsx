import { useEffect, useState } from "react";
import { Loading, usePluginAPI } from "../kit";

interface Status {
	setUp: boolean;
	chosenProviderId: string | null;
	activeProviderId: string;
	providers: Array<{ id: string; label: string }>;
}

/** Dashboard: whether payments are set up, with a way to finish (FIK-59). */
export function PaymentsSetup() {
	const api = usePluginAPI();
	const [status, setStatus] = useState<Status | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		api
			.get<Status>("admin/setup/status")
			.then(setStatus)
			.catch(() => setFailed(true));
	}, [api]);

	if (failed) return <p style={{ color: "#4b5563", margin: 0 }}>Payment status unavailable.</p>;
	if (!status) return <Loading />;

	const label =
		status.providers.find((p) => p.id === (status.chosenProviderId ?? status.activeProviderId))
			?.label ?? status.activeProviderId;

	if (status.setUp) {
		return (
			<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
				<span style={{ fontSize: "1.25em", fontWeight: 700, color: "#166534" }}>Connected</span>
				<span style={{ color: "#4b5563" }}>Customers pay with {label}.</span>
			</div>
		);
	}
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
			<span style={{ fontSize: "1.25em", fontWeight: 700, color: "#92400e" }}>Not set up</span>
			<span style={{ color: "#4b5563" }}>
				{status.chosenProviderId
					? `Finish setting up ${label} so customers can check out.`
					: "Choose a payment provider so customers can check out."}
			</span>
			<a href="#/settings" style={{ fontWeight: 600 }}>
				Set up payments →
			</a>
		</div>
	);
}
