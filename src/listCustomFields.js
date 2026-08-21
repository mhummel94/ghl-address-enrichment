/**
 * One-off script - NOT part of the running server.
 *
 * Run this once to find the id/fieldKey for your "Property Type" and
 * "Square Footage" (or whatever you named them) custom fields, so you
 * can fill in GHL_CUSTOM_FIELD_ID_PROPERTY_TYPE / _SQFT in your .env.
 *
 * Usage:
 *   node src/listCustomFields.js
 */
import { config } from './config.js';
import { getCustomFields } from './ghlClient.js';

const fields = await getCustomFields(config.ghl.locationId);

if (fields.length === 0) {
  console.log('No custom fields found on this location.');
  process.exit(0);
}

console.log(`Found ${fields.length} custom field(s) on this location:\n`);

for (const f of fields) {
  console.log(`name:      ${f.name}`);
  console.log(`id:        ${f.id}`);
  console.log(`fieldKey:  ${f.fieldKey}`);
  console.log(`dataType:  ${f.dataType}`);
  console.log('---');
}

// Quick highlight - flag anything that looks relevant so it's easy to
// spot in a long list.
const relevant = fields.filter((f) =>
  /property.?type|sq.?ft|square.?foot/i.test(f.name || '') ||
  /property.?type|sq.?ft|square.?foot/i.test(f.fieldKey || '')
);

if (relevant.length > 0) {
  console.log('\nLikely matches for propertyType/sqft:\n');
  for (const f of relevant) {
    console.log(`- ${f.name}  (id: ${f.id}, key: ${f.fieldKey})`);
  }
} else {
  console.log(
    '\nNo obvious "property type" or "square footage" fields found. ' +
    "If they don't exist yet, create them in GHL under Settings > Custom Fields, then re-run this script."
  );
}