import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

// Resolve .env relative to THIS file's location (project root, one level
// up from src/) rather than relying on the terminal's current directory.
// Prevents "missing env var" errors when a script is run from inside
// src/ instead of the project root.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

function required(name) {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val;
}

export const config = {
  ghl: {
    pitToken: required('GHL_PIT_TOKEN'),
    locationId: required('GHL_LOCATION_ID'),
    apiBase: process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com',
    apiVersion: process.env.GHL_API_VERSION || 'v3',
  },
  openai: {
    apiKey: required('OPENAI_API_KEY'),
    model: process.env.OPENAI_MODEL || 'gpt-5-mini',
  },
  propertyRadar: {
    // Optional for now - only needed once you start testing/using the
    // PropertyRadar fallback endpoint. Not validated at startup so the
    // rest of the service still runs fine without it.
    apiToken: process.env.PROPERTYRADAR_API_TOKEN || null,
    // Separate cost gate from DRY_RUN - controls whether a confirmed
    // PropertyRadar match is allowed to spend real money (~$0.02/match)
    // to pull the full property record. Defaults to false so nothing
    // gets charged without explicit opt-in.
    allowPurchase: (process.env.PROPERTYRADAR_ALLOW_PURCHASE || 'false').toLowerCase() === 'true',
  },
  ghlCustomFields: {
    // Optional. Required only if you want propertyType/sqft (pulled from
    // PropertyRadar) actually written back to GHL - these have no native
    // contact fields, only custom fields. GHL's official schema requires
    // the field `id` (internal string, e.g. "3sv6UEo51C9Bmpo1cKTq") to
    // write a value - `key` (the {{contact.field_key}} merge-tag format)
    // is optional but included too when available, since GHL's API
    // allows both together. Get both via
    // GET /locations/{locationId}/customFields (Version: v3), or from
    // the custom field's settings page in your GHL location. Left unset,
    // the values still show up in the /enrich-address response under
    // `foundButNotConfigured` - they just won't be persisted.
    propertyType: {
      id: process.env.GHL_CUSTOM_FIELD_ID_PROPERTY_TYPE || null,
      key: process.env.GHL_CUSTOM_FIELD_KEY_PROPERTY_TYPE || null,
    },
    sqft: {
      id: process.env.GHL_CUSTOM_FIELD_ID_SQFT || null,
      key: process.env.GHL_CUSTOM_FIELD_KEY_SQFT || null,
    },
  },
  service: {
    port: Number(process.env.PORT || 3000),
    lookbackHours: Number(process.env.LOOKBACK_HOURS || 48),
    dryRun: (process.env.DRY_RUN || 'true').toLowerCase() === 'true',
    serviceKey: process.env.SERVICE_KEY || null,
  },
};