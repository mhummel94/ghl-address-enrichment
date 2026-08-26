import express from 'express';
import { config } from './config.js';
import { gatherSources } from './gatherSources.js';
import { extractAddress } from './extractAddress.js';
import { updateContactAddress } from './ghlClient.js';
import { lookupPropertyByPartialAddress, lookupPropertyWithSuffixFallback, resolvePropertyDetails } from './propertyRadarClient.js';
import { mapToGhlPropertyType } from './propertyTypeMapping.js';

const app = express();
app.use(express.json());

// --- simple shared-secret auth ---
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!config.service.serviceKey) return next(); // auth disabled if unset
  if (req.header('x-service-key') !== config.service.serviceKey) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

app.get('/health', (req, res) => res.json({ ok: true }));

/**
 * POST /enrich-address
 * body: { contactId, address?, city?, state?, zip?, propertyType?, sqft? }
 *
 * `address`/`city`/`state`/`zip` are whatever GHL already has on file for
 * this contact (may be partially or fully empty). `propertyType`/`sqft`
 * are optional too - pass whatever's already in GHL (e.g. from custom
 * fields), blank/omitted if not tracked or not yet filled in.
 *
 * All six are treated the same way: pass in what you have, we only ever
 * fill genuine gaps, never overwrite existing values.
 *
 * NOTE: propertyType/sqft can only ever be filled via PropertyRadar (the
 * conversation/notes/transcript extraction step has no way to know these).
 * Writing them back to GHL requires custom field IDs configured via
 * GHL_CUSTOM_FIELD_ID_PROPERTY_TYPE / GHL_CUSTOM_FIELD_ID_SQFT - without
 * those set, the values still show up in the response for visibility,
 * they just won't be persisted to GHL.
 */
app.post('/enrich-address', async (req, res) => {
  // Diagnostic logging - shows up in Railway's logs. Helps confirm
  // whether an external caller (e.g. a GHL Workflow webhook) is actually
  // sending JSON with the right content-type and field names, vs.
  // sending something Express can't parse into req.body at all.
  console.log('POST /enrich-address received');
  console.log('  content-type:', req.header('content-type'));
  console.log('  raw body:', JSON.stringify(req.body));

  const { contactId, address, city, state, zip, propertyType, sqft } = req.body || {};

  if (!contactId) {
    return res.status(400).json({ error: 'contactId is required', receivedBody: req.body || null });
  }

  const existing = {
    address_1: address || null,
    city: city || null,
    state: state || null,
    postal_code: zip || null,
    propertyType: propertyType || null,
    sqft: sqft || null,
  };

  const missingFields = Object.entries(existing)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missingFields.length === 0) {
    return res.json({
      contactId,
      status: 'skipped',
      reason: 'no missing fields - nothing to enrich',
      existing,
    });
  }

  try {
    const sources = await gatherSources(contactId, config.ghl.locationId);
    const extracted = await extractAddress(sources, existing);

    // Merge: only fill fields that were actually missing. Never clobber
    // a value that was already on the contact record. propertyType/sqft
    // have no extraction source - they can only come from PropertyRadar.
    const merged = {
      address1: existing.address_1 || extracted.address_1,
      city: existing.city || extracted.city,
      state: existing.state || extracted.state,
      postalCode: existing.postal_code || extracted.postal_code,
      propertyType: existing.propertyType,
      sqft: existing.sqft,
    };

    // PropertyRadar fallback: only worth trying if we have SOME address
    // to search with, and only if there's still a gap after conversation/
    // notes/transcript extraction (now including propertyType/sqft, since
    // those can ONLY be filled by PropertyRadar). If we have no address
    // at all, there's nothing for PropertyRadar to look up.
    let propertyRadar = null;
    const stillMissingAfterExtraction =
      !merged.city || !merged.state || !merged.postalCode || !merged.propertyType || !merged.sqft;

    if (merged.address1 && stillMissingAfterExtraction) {
      propertyRadar = await resolvePropertyDetails(
        {
          address_1: merged.address1,
          address_2: extracted.address_2 || null,
          city: merged.city,
          state: merged.state,
          zip: merged.postalCode,
        },
        { allowPurchase: config.propertyRadar.allowPurchase }
      );

      if (propertyRadar?.record) {
        // Same gap-only rule as the GHL/extraction merge - never
        // overwrite a value we already have.
        merged.city = merged.city || propertyRadar.record.City;
        merged.state = merged.state || propertyRadar.record.State;
        merged.postalCode = merged.postalCode || propertyRadar.record.ZipFive;
        // Only accept a mapped value that confidently matches one of
        // GHL's exact dropdown options - a null mapping means we leave
        // this gap open rather than write something that might be wrong
        // or fail to register against the SINGLE_OPTIONS field.
        const mappedPropertyType = mapToGhlPropertyType({
          AdvancedPropertyType: propertyRadar.record.AdvancedPropertyType,
          PType: propertyRadar.record.PType,
        });
        merged.propertyType = merged.propertyType || mappedPropertyType;
        merged.sqft = merged.sqft || propertyRadar.record.SqFt;
      }
    }

    // Core fields go through update-contact's standard body (address1/
    // city/state/postalCode - the only address fields it supports).
    const coreFieldsToWrite = Object.entries({
      address1: merged.address1,
      city: merged.city,
      state: merged.state,
      postalCode: merged.postalCode,
    }).filter(([key, val]) => {
      const existingKey = { address1: 'address_1', city: 'city', state: 'state', postalCode: 'postal_code' }[key];
      return !existing[existingKey] && val;
    });

    // propertyType/sqft have no native GHL contact field - they can only
    // be written as custom fields, and only if you've configured the
    // field IDs. Otherwise we still report the found values so you can
    // see them and decide what to do (e.g. set up the custom fields,
    // then re-run).
    const customFieldGaps = Object.entries({
      propertyType: merged.propertyType,
      sqft: merged.sqft,
    }).filter(([key, val]) => !existing[key] && val);

    const customFieldIdMap = {
      propertyType: config.ghlCustomFields.propertyType,
      sqft: config.ghlCustomFields.sqft,
    };

    const customFieldsToWrite = [];
    const customFieldsFoundButNotConfigured = [];
    for (const [key, val] of customFieldGaps) {
      const fieldConfig = customFieldIdMap[key];
      if (fieldConfig?.id) {
        customFieldsToWrite.push({
          id: fieldConfig.id,
          ...(fieldConfig.key ? { key: fieldConfig.key } : {}),
          fieldValue: String(val),
        });
      } else {
        customFieldsFoundButNotConfigured.push({ key, value: val });
      }
    }

    const response = {
      contactId,
      existing,
      extracted,
      propertyRadar,
      sourcesConsidered: sources.length,
      wouldWrite: {
        ...Object.fromEntries(coreFieldsToWrite),
        ...(customFieldsToWrite.length > 0
          ? { customFields: customFieldsToWrite }
          : {}),
      },
      ...(customFieldsFoundButNotConfigured.length > 0
        ? { foundButNotConfigured: customFieldsFoundButNotConfigured }
        : {}),
    };

    if (coreFieldsToWrite.length === 0 && customFieldsToWrite.length === 0) {
      return res.json({ ...response, status: 'no_address_found' });
    }

    if (config.service.dryRun) {
      return res.json({ ...response, status: 'dry_run_not_written' });
    }

    const writeResult = await updateContactAddress(contactId, {
      address1: merged.address1,
      city: merged.city,
      state: merged.state,
      postalCode: merged.postalCode,
      customFields: customFieldsToWrite,
    });
    return res.json({ ...response, status: 'written', ghlResponse: writeResult });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /test-propertyradar
 * body: { address?, city?, state?, purchase? }
 *
 * Standalone test route - NOT wired into /enrich-address yet. Use this to
 * validate PropertyRadar's match behavior on partial input before we
 * decide how (or whether) to use it as a fallback.
 *
 * `purchase` defaults to 0 (free preview - no billed export). Only pass
 * `purchase: 1` once you're ready to actually spend credits confirming
 * a real match.
 */
app.post('/test-propertyradar', async (req, res) => {
  const { address, city, state, zip, purchase } = req.body || {};

  if (!address && !city && !state && !zip) {
    return res.status(400).json({ error: 'provide at least one of address, city, state, zip' });
  }

  try {
    const result = await lookupPropertyByPartialAddress(
      { address, city, state, zip },
      { purchase: purchase ?? 0 }
    );
    return res.json({ query: { address, city, state, zip }, ...result });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /test-propertyradar-smart
 * body: { address_1, address_2?, city?, state? }
 *
 * Uses lookupPropertyWithSuffixFallback - normalizes the suffix if it's a
 * recognized full word, and if no suffix is present at all, guesses
 * through a list of common suffixes until one matches. All guessing
 * attempts use Purchase=0 (free) - nothing is billed unless you take the
 * matchedAddress and call /test-propertyradar again with purchase: 1.
 */
app.post('/test-propertyradar-smart', async (req, res) => {
  const { address_1, address_2, city, state } = req.body || {};

  if (!address_1) {
    return res.status(400).json({ error: 'address_1 is required' });
  }

  try {
    const result = await lookupPropertyWithSuffixFallback({ address_1, address_2, city, state });
    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(config.service.port, () => {
  console.log(`Address enrichment service listening on :${config.service.port}`);
  console.log(`DRY_RUN=${config.service.dryRun}`);
  console.log(`PROPERTYRADAR_ALLOW_PURCHASE=${config.propertyRadar.allowPurchase}`);
});