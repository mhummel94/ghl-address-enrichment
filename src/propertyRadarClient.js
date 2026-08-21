import { config } from './config.js';

const BASE = 'https://api.propertyradar.com/v1';

async function radarFetch(path, { query, body } = {}) {
  if (!config.propertyRadar.apiToken) {
    throw new Error('PROPERTYRADAR_API_TOKEN is not set');
  }

  const url = new URL(BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        // This API only honors the LAST occurrence of a repeated query
        // key rather than accumulating them (confirmed empirically -
        // only the final Fields value came back on a real paid call).
        // Comma-join into a single value instead.
        url.searchParams.set(k, v.join(','));
      } else {
        url.searchParams.set(k, v);
      }
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.propertyRadar.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(
      `PropertyRadar API failed: ${res.status} ${JSON.stringify(json)}`
    );
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return json;
}

/**
 * Raw lookup - sends exactly the address/city/state you give it, no
 * normalization or guessing. Use this when you want full control, or
 * when testing format variations manually.
 *
 * `purchase` defaults to 0 (free preview - counts/cost only, no billed
 * export).
 */
export async function lookupPropertyByPartialAddress(
  { address, city, state, zip },
  { purchase = 0 } = {}
) {
  const criteria = [];
  if (address) criteria.push({ name: 'Address', value: [address] });
  if (city) criteria.push({ name: 'City', value: [city] });
  if (state) criteria.push({ name: 'State', value: [state] });
  if (zip) criteria.push({ name: 'ZipFive', value: [zip] });

  if (criteria.length === 0) {
    throw new Error(
      'lookupPropertyByPartialAddress requires at least one of address/city/state/zip'
    );
  }

  const res = await radarFetch('/properties', {
    query: {
      Purchase: purchase,
      Fields: [
        'FullAddress',
        'Address',
        'City',
        'State',
        'ZipFive',
        'RadarID',
        'PType',
        'AdvancedPropertyType',
        'SqFt',
        'YearBuilt',
        'Beds',
        'Baths',
        'Owner',
        'OwnerAddress',
        'OwnerCity',
        'OwnerState',
        'OwnerZipFive',
      ],
    },
    body: { Criteria: criteria },
  });

  return {
    resultCount: res.resultCount ?? (res.results ? res.results.length : 0),
    totalResultCount: res.totalResultCount,
    totalCost: res.totalCost,
    quantityFreeRemaining: res.quantityFreeRemaining,
    results: res.results || [],
  };
}

// --- Normalization: confirmed empirically against real PropertyRadar
// data. Matching requires the ABBREVIATED street suffix, with any unit
// number folded directly into the address string. Case doesn't matter.

// Common full-word suffix -> USPS abbreviation. Lookup is case-insensitive.
const SUFFIX_ABBREVIATIONS = {
  street: 'St',
  avenue: 'Ave',
  boulevard: 'Blvd',
  drive: 'Dr',
  lane: 'Ln',
  road: 'Rd',
  court: 'Ct',
  place: 'Pl',
  terrace: 'Ter',
  circle: 'Cir',
  trail: 'Trl',
  parkway: 'Pkwy',
  highway: 'Hwy',
  square: 'Sq',
  crossing: 'Xing',
  point: 'Pt',
  ridge: 'Rdg',
  heights: 'Hts',
  way: 'Way',
  loop: 'Loop',
  path: 'Path',
  row: 'Row',
  walk: 'Walk',
};

// Recognized abbreviations (values above, plus a few common ones with no
// full-word equivalent worth mapping). Used to detect "this address
// already has a suffix" vs. "no suffix present at all".
const KNOWN_ABBREVIATIONS = new Set([
  ...Object.values(SUFFIX_ABBREVIATIONS).map((s) => s.toLowerCase()),
  'aly', 'anx', 'byp', 'cor', 'cv', 'crk', 'xrd', 'ext', 'fwy', 'grn',
  'hl', 'is', 'jct', 'knl', 'mnr', 'mdw', 'pln', 'plz', 'rte', 'shrs',
  'spg', 'sta', 'vly', 'vw', 'vlg',
]);

// Ordered by rough real-world frequency - most common tried first to
// minimize API calls when guessing.
const SUFFIX_GUESS_ORDER = [
  'St', 'Ave', 'Dr', 'Ln', 'Rd', 'Ct', 'Blvd', 'Pl', 'Way', 'Ter',
  'Cir', 'Pkwy', 'Trl', 'Hwy', 'Loop', 'Sq',
];

function foldUnitIntoAddress(address1, address2) {
  return address2 ? `${address1} ${address2}`.trim() : (address1 || '').trim();
}

/**
 * Expands or leaves alone the street suffix in an already-assembled
 * address string (street number + name + optional unit). Only touches
 * the token immediately before a detected unit designator, or the last
 * token if there's no unit.
 */
function normalizeSuffix(fullAddress) {
  const tokens = fullAddress.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { normalized: fullAddress, hasSuffix: false };

  // Find where the unit portion starts (Unit/Apt/#/Ste etc.) so we know
  // which token is actually the street suffix, not part of the unit.
  const unitMarkerIdx = tokens.findIndex((t) =>
    /^(unit|apt|ste|suite|#|no\.?)$/i.test(t)
  );
  const suffixIdx = unitMarkerIdx === -1 ? tokens.length - 1 : unitMarkerIdx - 1;

  if (suffixIdx < 0) return { normalized: fullAddress, hasSuffix: false };

  const rawSuffix = tokens[suffixIdx];
  const lower = rawSuffix.toLowerCase().replace(/\.$/, '');

  if (SUFFIX_ABBREVIATIONS[lower]) {
    tokens[suffixIdx] = SUFFIX_ABBREVIATIONS[lower];
    return { normalized: tokens.join(' '), hasSuffix: true };
  }

  if (KNOWN_ABBREVIATIONS.has(lower)) {
    // Already abbreviated - leave as-is.
    return { normalized: fullAddress, hasSuffix: true };
  }

  return { normalized: fullAddress, hasSuffix: false };
}

/**
 * Smart lookup: builds the best-guess PropertyRadar-formatted address
 * (abbreviated suffix, unit folded in), tries it, and if that returns no
 * match AND no suffix was detected at all, iterates through common
 * suffix guesses appended to the address until one hits or the list is
 * exhausted.
 *
 * All attempts use Purchase=0 (free preview) - only the winning query
 * needs to be re-run with Purchase=1 if you want the actual field data.
 *
 * Returns the first successful attempt's result, plus metadata on what
 * was tried, so you can see which variant (if any) actually matched.
 */
export async function lookupPropertyWithSuffixFallback({
  address_1,
  address_2,
  city,
  state,
  zip,
}) {
  const attempts = [];
  const baseAddress = foldUnitIntoAddress(address_1, address_2);

  if (!baseAddress) {
    throw new Error('lookupPropertyWithSuffixFallback requires address_1');
  }

  const { normalized, hasSuffix } = normalizeSuffix(baseAddress);

  // Attempt 1: normalized address as given (suffix abbreviated if it was
  // recognized as a full word; left alone otherwise).
  const first = await lookupPropertyByPartialAddress(
    { address: normalized, city, state, zip },
    { purchase: 0 }
  );
  attempts.push({ address: normalized, totalResultCount: first.totalResultCount });

  if (first.totalResultCount > 0) {
    return { matched: true, matchedAddress: normalized, attempts, result: first };
  }

  // Only guess additional suffixes if the address genuinely appears to
  // have none at all - if a suffix was already present (even if wrong),
  // guessing a different one is unlikely to be the right fix and burns
  // API calls for little benefit.
  if (hasSuffix) {
    return { matched: false, matchedAddress: null, attempts, result: first };
  }

  for (const suffix of SUFFIX_GUESS_ORDER) {
    const guessAddress = address_2
      ? `${baseAddress.replace(address_2, '').trim()} ${suffix} ${address_2}`.trim()
      : `${baseAddress} ${suffix}`;

    const attempt = await lookupPropertyByPartialAddress(
      { address: guessAddress, city, state, zip },
      { purchase: 0 }
    );
    attempts.push({ address: guessAddress, totalResultCount: attempt.totalResultCount });

    if (attempt.totalResultCount > 0) {
      return { matched: true, matchedAddress: guessAddress, attempts, result: attempt };
    }
  }

  return { matched: false, matchedAddress: null, attempts, result: null };
}

/**
 * Full resolution used by the real enrichment flow: runs the free
 * suffix-fallback matching first, and ONLY IF a match is found AND
 * purchases are explicitly allowed (config.propertyRadar.allowPurchase),
 * re-runs the winning query with Purchase=1 to pull the actual property
 * record (site address, zip, property type, sqft, beds, baths, owner
 * info, etc).
 *
 * This keeps every failed/guessed attempt free - money is only spent on
 * the single confirmed winning query, and only when the operator has
 * explicitly opted into spending it.
 */
export async function resolvePropertyDetails(
  { address_1, address_2, city, state, zip },
  { allowPurchase = false } = {}
) {
  const fallback = await lookupPropertyWithSuffixFallback({
    address_1,
    address_2,
    city,
    state,
    zip,
  });

  if (!fallback.matched) {
    return { matched: false, attempts: fallback.attempts, record: null };
  }

  if (!allowPurchase) {
    return {
      matched: true,
      matchedAddress: fallback.matchedAddress,
      attempts: fallback.attempts,
      purchased: false,
      note: 'Match found but PROPERTYRADAR_ALLOW_PURCHASE is not enabled - set it to true to spend ~$0.02 and pull the full property record.',
      record: null,
    };
  }

  const purchased = await lookupPropertyByPartialAddress(
    { address: fallback.matchedAddress, city, state, zip },
    { purchase: 1 }
  );

  return {
    matched: true,
    matchedAddress: fallback.matchedAddress,
    attempts: fallback.attempts,
    purchased: true,
    cost: purchased.totalCost,
    record: purchased.results?.[0] || null,
  };
}