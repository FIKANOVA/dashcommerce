/**
 * Kenyan county shipping-zone presets.
 * Ready-made `ShippingZone`/`ShippingMethod` rows matching @dashcommerce/core's
 * types, allowing operators to seed presets rather than configuring 47 counties manually.
 */

import type { ShippingMethod, ShippingZone } from "@dashcommerce/core";

export const KENYA_COUNTY_CODES = [
	"Nairobi",
	"Mombasa",
	"Kwale",
	"Kilifi",
	"Tana River",
	"Lamu",
	"Taita-Taveta",
	"Garissa",
	"Wajir",
	"Mandera",
	"Marsabit",
	"Isiolo",
	"Meru",
	"Tharaka-Nithi",
	"Embu",
	"Kitui",
	"Machakos",
	"Makueni",
	"Nyandarua",
	"Nyeri",
	"Kirinyaga",
	"Murang'a",
	"Kiambu",
	"Turkana",
	"West Pokot",
	"Samburu",
	"Trans Nzoia",
	"Uasin Gishu",
	"Elgeyo-Marakwet",
	"Nandi",
	"Baringo",
	"Laikipia",
	"Nakuru",
	"Narok",
	"Kajiado",
	"Bomet",
	"Kakamega",
	"Vihiga",
	"Bungoma",
	"Busia",
	"Siaya",
	"Kisumu",
	"Homa Bay",
	"Migori",
	"Kisii",
	"Nyamira",
] as const;

export type KenyaCounty = (typeof KENYA_COUNTY_CODES)[number];

export const NAIROBI_METRO_COUNTIES: KenyaCounty[] = [
	"Kiambu",
	"Kajiado",
	"Machakos",
	"Murang'a",
];

export const REST_OF_KENYA_COUNTIES: KenyaCounty[] = KENYA_COUNTY_CODES.filter(
	(c) => c !== "Nairobi" && !NAIROBI_METRO_COUNTIES.includes(c),
);

export interface KenyaShippingPresetOptions {
	nairobiMinorUnits?: number; // default 30000 (KES 300.00)
	metroMinorUnits?: number; // default 50000 (KES 500.00)
	restOfKenyaMinorUnits?: number; // default 75000 (KES 750.00)
	pickupMinorUnits?: number; // default 0 (free pickup)
	now?: () => string;
}

export function createKenyaShippingPresets(opts: KenyaShippingPresetOptions = {}): {
	zones: ShippingZone[];
	methods: ShippingMethod[];
} {
	const nowIso = (opts.now ?? (() => new Date().toISOString()))();
	const nairobiAmt = opts.nairobiMinorUnits ?? 30000;
	const metroAmt = opts.metroMinorUnits ?? 50000;
	const restAmt = opts.restOfKenyaMinorUnits ?? 75000;
	const pickupAmt = opts.pickupMinorUnits ?? 0;

	const zoneNairobi: ShippingZone = {
		id: "zone_ke_nairobi",
		name: "Nairobi County",
		locations: [{ country: "KE", regions: ["Nairobi"] }],
		order: 10,
		createdAt: nowIso,
		updatedAt: nowIso,
	};

	const zoneMetro: ShippingZone = {
		id: "zone_ke_metro",
		name: "Nairobi Metro Ring",
		locations: [{ country: "KE", regions: [...NAIROBI_METRO_COUNTIES] }],
		order: 20,
		createdAt: nowIso,
		updatedAt: nowIso,
	};

	const zoneRest: ShippingZone = {
		id: "zone_ke_rest",
		name: "Rest of Kenya",
		locations: [{ country: "KE", regions: [...REST_OF_KENYA_COUNTIES] }],
		order: 30,
		createdAt: nowIso,
		updatedAt: nowIso,
	};

	const methods: ShippingMethod[] = [
		{
			id: "sm_ke_nbi_courier",
			zoneId: zoneNairobi.id,
			type: "flat_rate",
			title: "Nairobi Same-Day / Next-Day Courier",
			enabled: true,
			order: 1,
			config: {
				type: "flat_rate",
				amount: { amount: nairobiAmt, currency: "KES" },
			},
		},
		{
			id: "sm_ke_nbi_pickup",
			zoneId: zoneNairobi.id,
			type: "local_pickup",
			title: "Clubhouse / Matchday Pickup",
			enabled: true,
			order: 2,
			config: {
				type: "local_pickup",
				amount: { amount: pickupAmt, currency: "KES" },
			},
		},
		{
			id: "sm_ke_metro_courier",
			zoneId: zoneMetro.id,
			type: "flat_rate",
			title: "Metro Area Courier (Kiambu/Kajiado/Machakos)",
			enabled: true,
			order: 1,
			config: {
				type: "flat_rate",
				amount: { amount: metroAmt, currency: "KES" },
			},
		},
		{
			id: "sm_ke_rest_courier",
			zoneId: zoneRest.id,
			type: "flat_rate",
			title: "National Courier / Parcel Service (Upcountry)",
			enabled: true,
			order: 1,
			config: {
				type: "flat_rate",
				amount: { amount: restAmt, currency: "KES" },
			},
		},
	];

	return {
		zones: [zoneNairobi, zoneMetro, zoneRest],
		methods,
	};
}
