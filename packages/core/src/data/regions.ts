/**
 * Region names for shipping zones and checkout.
 *
 * A region is stored as the subdivision part of its ISO 3166-2 code:
 * Nairobi City is `KE-30`, stored as `30` on a zone location whose
 * country is `KE`. Note that ISO numbers Kenya's counties alphabetically,
 * which is not the order of the government's own county numbers.
 *
 * Only countries listed here get named regions in the admin; for others a
 * merchant types the codes, and the codes are shown as they are. Codes and
 * names follow ISO 3166-2 (checked against Debian iso-codes 4.20). Names are
 * the common English form ("Abu Dhabi", "Dubai"), and Brazil keeps its
 * accents ("São Paulo").
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
	NG: {
		label: "State",
		regions: [
			{ code: "AB", name: "Abia" },
			{ code: "AD", name: "Adamawa" },
			{ code: "AK", name: "Akwa Ibom" },
			{ code: "AN", name: "Anambra" },
			{ code: "BA", name: "Bauchi" },
			{ code: "BE", name: "Benue" },
			{ code: "BO", name: "Borno" },
			{ code: "BY", name: "Bayelsa" },
			{ code: "CR", name: "Cross River" },
			{ code: "DE", name: "Delta" },
			{ code: "EB", name: "Ebonyi" },
			{ code: "ED", name: "Edo" },
			{ code: "EK", name: "Ekiti" },
			{ code: "EN", name: "Enugu" },
			{ code: "FC", name: "Federal Capital Territory" },
			{ code: "GO", name: "Gombe" },
			{ code: "IM", name: "Imo" },
			{ code: "JI", name: "Jigawa" },
			{ code: "KD", name: "Kaduna" },
			{ code: "KE", name: "Kebbi" },
			{ code: "KN", name: "Kano" },
			{ code: "KO", name: "Kogi" },
			{ code: "KT", name: "Katsina" },
			{ code: "KW", name: "Kwara" },
			{ code: "LA", name: "Lagos" },
			{ code: "NA", name: "Nasarawa" },
			{ code: "NI", name: "Niger" },
			{ code: "OG", name: "Ogun" },
			{ code: "ON", name: "Ondo" },
			{ code: "OS", name: "Osun" },
			{ code: "OY", name: "Oyo" },
			{ code: "PL", name: "Plateau" },
			{ code: "RI", name: "Rivers" },
			{ code: "SO", name: "Sokoto" },
			{ code: "TA", name: "Taraba" },
			{ code: "YO", name: "Yobe" },
			{ code: "ZA", name: "Zamfara" },
		],
	},
	CA: {
		label: "Province or territory",
		regions: [
			{ code: "AB", name: "Alberta" },
			{ code: "BC", name: "British Columbia" },
			{ code: "MB", name: "Manitoba" },
			{ code: "NB", name: "New Brunswick" },
			{ code: "NL", name: "Newfoundland and Labrador" },
			{ code: "NS", name: "Nova Scotia" },
			{ code: "NT", name: "Northwest Territories" },
			{ code: "NU", name: "Nunavut" },
			{ code: "ON", name: "Ontario" },
			{ code: "PE", name: "Prince Edward Island" },
			{ code: "QC", name: "Quebec" },
			{ code: "SK", name: "Saskatchewan" },
			{ code: "YT", name: "Yukon" },
		],
	},
	AU: {
		label: "State or territory",
		regions: [
			{ code: "ACT", name: "Australian Capital Territory" },
			{ code: "NSW", name: "New South Wales" },
			{ code: "NT", name: "Northern Territory" },
			{ code: "QLD", name: "Queensland" },
			{ code: "SA", name: "South Australia" },
			{ code: "TAS", name: "Tasmania" },
			{ code: "VIC", name: "Victoria" },
			{ code: "WA", name: "Western Australia" },
		],
	},
	IN: {
		label: "State or union territory",
		regions: [
			{ code: "AN", name: "Andaman and Nicobar Islands" },
			{ code: "AP", name: "Andhra Pradesh" },
			{ code: "AR", name: "Arunachal Pradesh" },
			{ code: "AS", name: "Assam" },
			{ code: "BR", name: "Bihar" },
			{ code: "CG", name: "Chhattisgarh" },
			{ code: "CH", name: "Chandigarh" },
			{ code: "DH", name: "Dadra and Nagar Haveli and Daman and Diu" },
			{ code: "DL", name: "Delhi" },
			{ code: "GA", name: "Goa" },
			{ code: "GJ", name: "Gujarat" },
			{ code: "HP", name: "Himachal Pradesh" },
			{ code: "HR", name: "Haryana" },
			{ code: "JH", name: "Jharkhand" },
			{ code: "JK", name: "Jammu and Kashmir" },
			{ code: "KA", name: "Karnataka" },
			{ code: "KL", name: "Kerala" },
			{ code: "LA", name: "Ladakh" },
			{ code: "LD", name: "Lakshadweep" },
			{ code: "MH", name: "Maharashtra" },
			{ code: "ML", name: "Meghalaya" },
			{ code: "MN", name: "Manipur" },
			{ code: "MP", name: "Madhya Pradesh" },
			{ code: "MZ", name: "Mizoram" },
			{ code: "NL", name: "Nagaland" },
			{ code: "OD", name: "Odisha" },
			{ code: "PB", name: "Punjab" },
			{ code: "PY", name: "Puducherry" },
			{ code: "RJ", name: "Rajasthan" },
			{ code: "SK", name: "Sikkim" },
			{ code: "TN", name: "Tamil Nadu" },
			{ code: "TR", name: "Tripura" },
			{ code: "TS", name: "Telangana" },
			{ code: "UK", name: "Uttarakhand" },
			{ code: "UP", name: "Uttar Pradesh" },
			{ code: "WB", name: "West Bengal" },
		],
	},
	BR: {
		label: "State",
		regions: [
			{ code: "AC", name: "Acre" },
			{ code: "AL", name: "Alagoas" },
			{ code: "AM", name: "Amazonas" },
			{ code: "AP", name: "Amapá" },
			{ code: "BA", name: "Bahia" },
			{ code: "CE", name: "Ceará" },
			{ code: "DF", name: "Distrito Federal" },
			{ code: "ES", name: "Espírito Santo" },
			{ code: "GO", name: "Goiás" },
			{ code: "MA", name: "Maranhão" },
			{ code: "MG", name: "Minas Gerais" },
			{ code: "MS", name: "Mato Grosso do Sul" },
			{ code: "MT", name: "Mato Grosso" },
			{ code: "PA", name: "Pará" },
			{ code: "PB", name: "Paraíba" },
			{ code: "PE", name: "Pernambuco" },
			{ code: "PI", name: "Piauí" },
			{ code: "PR", name: "Paraná" },
			{ code: "RJ", name: "Rio de Janeiro" },
			{ code: "RN", name: "Rio Grande do Norte" },
			{ code: "RO", name: "Rondônia" },
			{ code: "RR", name: "Roraima" },
			{ code: "RS", name: "Rio Grande do Sul" },
			{ code: "SC", name: "Santa Catarina" },
			{ code: "SE", name: "Sergipe" },
			{ code: "SP", name: "São Paulo" },
			{ code: "TO", name: "Tocantins" },
		],
	},
	ZA: {
		label: "Province",
		regions: [
			{ code: "EC", name: "Eastern Cape" },
			{ code: "FS", name: "Free State" },
			{ code: "GP", name: "Gauteng" },
			{ code: "KZN", name: "KwaZulu-Natal" },
			{ code: "LP", name: "Limpopo" },
			{ code: "MP", name: "Mpumalanga" },
			{ code: "NC", name: "Northern Cape" },
			{ code: "NW", name: "North West" },
			{ code: "WC", name: "Western Cape" },
		],
	},
	AE: {
		label: "Emirate",
		regions: [
			{ code: "AJ", name: "Ajman" },
			{ code: "AZ", name: "Abu Dhabi" },
			{ code: "DU", name: "Dubai" },
			{ code: "FU", name: "Fujairah" },
			{ code: "RK", name: "Ras Al Khaimah" },
			{ code: "SH", name: "Sharjah" },
			{ code: "UQ", name: "Umm Al Quwain" },
		],
	},
	JP: {
		label: "Prefecture",
		regions: [
			{ code: "01", name: "Hokkaido" },
			{ code: "02", name: "Aomori" },
			{ code: "03", name: "Iwate" },
			{ code: "04", name: "Miyagi" },
			{ code: "05", name: "Akita" },
			{ code: "06", name: "Yamagata" },
			{ code: "07", name: "Fukushima" },
			{ code: "08", name: "Ibaraki" },
			{ code: "09", name: "Tochigi" },
			{ code: "10", name: "Gunma" },
			{ code: "11", name: "Saitama" },
			{ code: "12", name: "Chiba" },
			{ code: "13", name: "Tokyo" },
			{ code: "14", name: "Kanagawa" },
			{ code: "15", name: "Niigata" },
			{ code: "16", name: "Toyama" },
			{ code: "17", name: "Ishikawa" },
			{ code: "18", name: "Fukui" },
			{ code: "19", name: "Yamanashi" },
			{ code: "20", name: "Nagano" },
			{ code: "21", name: "Gifu" },
			{ code: "22", name: "Shizuoka" },
			{ code: "23", name: "Aichi" },
			{ code: "24", name: "Mie" },
			{ code: "25", name: "Shiga" },
			{ code: "26", name: "Kyoto" },
			{ code: "27", name: "Osaka" },
			{ code: "28", name: "Hyogo" },
			{ code: "29", name: "Nara" },
			{ code: "30", name: "Wakayama" },
			{ code: "31", name: "Tottori" },
			{ code: "32", name: "Shimane" },
			{ code: "33", name: "Okayama" },
			{ code: "34", name: "Hiroshima" },
			{ code: "35", name: "Yamaguchi" },
			{ code: "36", name: "Tokushima" },
			{ code: "37", name: "Kagawa" },
			{ code: "38", name: "Ehime" },
			{ code: "39", name: "Kochi" },
			{ code: "40", name: "Fukuoka" },
			{ code: "41", name: "Saga" },
			{ code: "42", name: "Nagasaki" },
			{ code: "43", name: "Kumamoto" },
			{ code: "44", name: "Oita" },
			{ code: "45", name: "Miyazaki" },
			{ code: "46", name: "Kagoshima" },
			{ code: "47", name: "Okinawa" },
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

/**
 * Names compare loosely: "Nairobi", "nairobi city" and "Nairobi County" are
 * one key, and so are "São Paulo" and "Sao Paulo".
 */
function nameKey(value: string): string {
	return value
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
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
