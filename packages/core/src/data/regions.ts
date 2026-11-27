/**
 * Region names for shipping zones and checkout.
 *
 * A region is stored as the subdivision part of its ISO 3166-2 code:
 * Nairobi City is `KE-30`, stored as `30` on a zone location whose
 * country is `KE`. Note that ISO numbers Kenya's counties alphabetically,
 * which is not the order of the government's own county numbers.
 *
 * Only countries listed here get named regions in the admin; for others a
 * merchant types the codes, and the codes are shown as they are.
 */

export interface RegionInfo {
	code: string;
	name: string;
}

export interface CountryRegions {
	/** What the country calls its regions, e.g. "County". */
	label: string;
	regions: readonly RegionInfo[];
}

export const REGION_TABLE: Readonly<Record<string, CountryRegions>> = {
	KE: {
		label: "County",
		regions: [
			{ code: "01", name: "Baringo" },
			{ code: "02", name: "Bomet" },
			{ code: "03", name: "Bungoma" },
			{ code: "04", name: "Busia" },
			{ code: "05", name: "Elgeyo-Marakwet" },
			{ code: "06", name: "Embu" },
			{ code: "07", name: "Garissa" },
			{ code: "08", name: "Homa Bay" },
			{ code: "09", name: "Isiolo" },
			{ code: "10", name: "Kajiado" },
			{ code: "11", name: "Kakamega" },
			{ code: "12", name: "Kericho" },
			{ code: "13", name: "Kiambu" },
			{ code: "14", name: "Kilifi" },
			{ code: "15", name: "Kirinyaga" },
			{ code: "16", name: "Kisii" },
			{ code: "17", name: "Kisumu" },
			{ code: "18", name: "Kitui" },
			{ code: "19", name: "Kwale" },
			{ code: "20", name: "Laikipia" },
			{ code: "21", name: "Lamu" },
			{ code: "22", name: "Machakos" },
			{ code: "23", name: "Makueni" },
			{ code: "24", name: "Mandera" },
			{ code: "25", name: "Marsabit" },
			{ code: "26", name: "Meru" },
			{ code: "27", name: "Migori" },
			{ code: "28", name: "Mombasa" },
			{ code: "29", name: "Murang'a" },
			{ code: "30", name: "Nairobi City" },
			{ code: "31", name: "Nakuru" },
			{ code: "32", name: "Nandi" },
			{ code: "33", name: "Narok" },
			{ code: "34", name: "Nyamira" },
			{ code: "35", name: "Nyandarua" },
			{ code: "36", name: "Nyeri" },
			{ code: "37", name: "Samburu" },
			{ code: "38", name: "Siaya" },
			{ code: "39", name: "Taita-Taveta" },
			{ code: "40", name: "Tana River" },
			{ code: "41", name: "Tharaka-Nithi" },
			{ code: "42", name: "Trans Nzoia" },
			{ code: "43", name: "Turkana" },
			{ code: "44", name: "Uasin Gishu" },
			{ code: "45", name: "Vihiga" },
			{ code: "46", name: "Wajir" },
			{ code: "47", name: "West Pokot" },
		],
	},
	US: {
		label: "State",
		regions: [
			{ code: "AL", name: "Alabama" },
			{ code: "AK", name: "Alaska" },
			{ code: "AZ", name: "Arizona" },
			{ code: "AR", name: "Arkansas" },
			{ code: "CA", name: "California" },
			{ code: "CO", name: "Colorado" },
			{ code: "CT", name: "Connecticut" },
			{ code: "DE", name: "Delaware" },
			{ code: "DC", name: "District of Columbia" },
			{ code: "FL", name: "Florida" },
			{ code: "GA", name: "Georgia" },
			{ code: "HI", name: "Hawaii" },
			{ code: "ID", name: "Idaho" },
			{ code: "IL", name: "Illinois" },
			{ code: "IN", name: "Indiana" },
			{ code: "IA", name: "Iowa" },
			{ code: "KS", name: "Kansas" },
			{ code: "KY", name: "Kentucky" },
			{ code: "LA", name: "Louisiana" },
			{ code: "ME", name: "Maine" },
			{ code: "MD", name: "Maryland" },
			{ code: "MA", name: "Massachusetts" },
			{ code: "MI", name: "Michigan" },
			{ code: "MN", name: "Minnesota" },
			{ code: "MS", name: "Mississippi" },
			{ code: "MO", name: "Missouri" },
			{ code: "MT", name: "Montana" },
			{ code: "NE", name: "Nebraska" },
			{ code: "NV", name: "Nevada" },
			{ code: "NH", name: "New Hampshire" },
			{ code: "NJ", name: "New Jersey" },
			{ code: "NM", name: "New Mexico" },
			{ code: "NY", name: "New York" },
			{ code: "NC", name: "North Carolina" },
			{ code: "ND", name: "North Dakota" },
			{ code: "OH", name: "Ohio" },
			{ code: "OK", name: "Oklahoma" },
			{ code: "OR", name: "Oregon" },
			{ code: "PA", name: "Pennsylvania" },
			{ code: "RI", name: "Rhode Island" },
			{ code: "SC", name: "South Carolina" },
			{ code: "SD", name: "South Dakota" },
			{ code: "TN", name: "Tennessee" },
			{ code: "TX", name: "Texas" },
			{ code: "UT", name: "Utah" },
			{ code: "VT", name: "Vermont" },
			{ code: "VA", name: "Virginia" },
			{ code: "WA", name: "Washington" },
			{ code: "WV", name: "West Virginia" },
			{ code: "WI", name: "Wisconsin" },
			{ code: "WY", name: "Wyoming" },
		],
	},
};

/** The region's name, or its code when the country has no names here. */
export function regionName(country: string, code: string): string {
	return REGION_TABLE[country]?.regions.find((r) => r.code === code)?.name ?? code;
}

/** What the country calls its regions; "Region" when it has no names here. */
export function regionLabel(country: string): string {
	return REGION_TABLE[country]?.label ?? "Region";
}

/** Names compare loosely: "Nairobi", "nairobi city" and "Nairobi County" are one key. */
function nameKey(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z]/g, "")
		.replace(/(city|county)$/, "");
}

/**
 * The ISO 3166-2 subdivision part for a region a shopper or a payment page
 * gave: `KE-30` becomes `30` when the country is KE, and a name the table
 * knows ("Nairobi", "nairobi city") becomes its code. Anything else comes
 * back trimmed, as given.
 */
export function regionCode(country: string, value: string): string {
	const cc = country.trim().toUpperCase();
	let region = value.trim();
	if (cc && region.toUpperCase().startsWith(`${cc}-`)) region = region.slice(cc.length + 1).trim();
	const known = REGION_TABLE[cc]?.regions;
	if (!known || region === "") return region;
	const byCode = known.find((r) => r.code === region.toUpperCase());
	if (byCode) return byCode.code;
	const key = nameKey(region);
	if (!key) return region;
	return known.find((r) => nameKey(r.name) === key)?.code ?? region;
}
