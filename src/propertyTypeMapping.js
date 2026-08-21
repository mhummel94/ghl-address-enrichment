/**
 * Maps PropertyRadar's property type fields to the EXACT option strings
 * configured in your GHL "Property Type" dropdown (SINGLE_OPTIONS field).
 * A SINGLE_OPTIONS field only accepts one of its pre-configured values -
 * sending anything else either fails or silently doesn't register.
 *
 * Your GHL dropdown's real options (confirmed via listCustomFields.js):
 *   Single Family, Condoinium, Townhome, Manufactured/Mobile, MFU (2-4)
 *
 * Note: "Condoinium" is spelled that way (missing the second "m") in your
 * actual GHL field configuration - this is intentional, matching the
 * dropdown exactly, not a typo introduced here.
 *
 * PropertyRadar's basic `PType` field is too coarse to distinguish
 * Townhome or Manufactured/Mobile from Single Family - those only show up
 * in the more granular `AdvancedPropertyType` field. So this checks
 * AdvancedPropertyType first, and only falls back to PType if
 * AdvancedPropertyType is missing or unrecognized.
 */

const GHL_OPTIONS = {
  SINGLE_FAMILY: 'Single Family',
  CONDO: 'Condominium', // intentional - matches GHL's actual dropdown spelling
  TOWNHOME: 'Townhome',
  MANUFACTURED_MOBILE: 'Manufactured/Mobile',
  MFU_2_4: 'MFU (2-4)',
};

// Keyed by lowercased PropertyRadar AdvancedPropertyType value.
const ADVANCED_TYPE_MAP = {
  'single family residence': GHL_OPTIONS.SINGLE_FAMILY,
  'pud': GHL_OPTIONS.SINGLE_FAMILY,

  'condominium': GHL_OPTIONS.CONDO,
  'condotel': GHL_OPTIONS.CONDO,
  'high rise condo': GHL_OPTIONS.CONDO,
  'mid rise condo': GHL_OPTIONS.CONDO,
  'condominium project': GHL_OPTIONS.CONDO,
  'commercial condominium': GHL_OPTIONS.CONDO,
  'medical condo': GHL_OPTIONS.CONDO,
  'industrial condominium': GHL_OPTIONS.CONDO,
  'time share condo': GHL_OPTIONS.CONDO,

  'townhouse/rowhouse': GHL_OPTIONS.TOWNHOME,

  'manufactured home': GHL_OPTIONS.MANUFACTURED_MOBILE,
  'mobile home': GHL_OPTIONS.MANUFACTURED_MOBILE,
  'vacant mobile home': GHL_OPTIONS.MANUFACTURED_MOBILE,
  'mobile home lot': GHL_OPTIONS.MANUFACTURED_MOBILE,
  'mobile home park': GHL_OPTIONS.MANUFACTURED_MOBILE,

  'duplex': GHL_OPTIONS.MFU_2_4,
  'triplex': GHL_OPTIONS.MFU_2_4,
  'quadruplex': GHL_OPTIONS.MFU_2_4,
};

// Fallback keyed by lowercased basic PType value - used ONLY when
// AdvancedPropertyType is entirely missing from the record. Real
// PropertyRadar responses return PType as short codes (e.g. "SFR", "CND",
// "MFR"), not the full words PropertyRadar's docs imply - confirmed
// empirically. Kept both forms as keys since it costs nothing and
// protects against either shape showing up.
const BASIC_PTYPE_MAP = {
  sfr: GHL_OPTIONS.SINGLE_FAMILY,
  'single family': GHL_OPTIONS.SINGLE_FAMILY,

  cnd: GHL_OPTIONS.CONDO,
  condominium: GHL_OPTIONS.CONDO,

  // NOTE: "MFR" alone does not distinguish a 2-4 unit property from a
  // larger 5+ unit building - PropertyRadar's coarse PType code doesn't
  // carry that distinction. This fallback is only reached when
  // AdvancedPropertyType is completely absent, which real data suggests
  // is rare. When AdvancedPropertyType IS present, it's used exclusively
  // (see below) specifically to avoid a large apartment building being
  // miscategorized into the "MFU (2-4)" bucket just because its coarse
  // PType happens to read "MFR".
  mfr: GHL_OPTIONS.MFU_2_4,
  'multi-family 2-4': GHL_OPTIONS.MFU_2_4,
};

/**
 * Returns the exact GHL dropdown option string, or null if nothing in
 * the PropertyRadar record confidently maps to one of the five options.
 * A null return means: don't write this field - better to leave it
 * blank than write a guess that mismatches an unrelated property type.
 */
export function mapToGhlPropertyType({ AdvancedPropertyType, PType } = {}) {
  if (AdvancedPropertyType) {
    // AdvancedPropertyType was returned - treat it as authoritative and
    // do NOT fall back to the coarser PType code even if this specific
    // AdvancedPropertyType value isn't one we recognize. Falling back
    // here is exactly how a 10+ unit apartment building (PType="MFR" but
    // AdvancedPropertyType="Apartment") could get miscategorized as a
    // small 2-4 unit property - better to leave the field blank.
    return ADVANCED_TYPE_MAP[AdvancedPropertyType.toLowerCase()] || null;
  }

  // Only reached when AdvancedPropertyType wasn't returned at all.
  if (PType) {
    return BASIC_PTYPE_MAP[PType.toLowerCase()] || null;
  }

  return null;
}