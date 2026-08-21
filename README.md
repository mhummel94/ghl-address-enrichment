# GHL Address/Property Enrichment Service

One-off, human-triggered safety net: given a `contactId` and whatever
address fields GHL already has (some possibly empty), this:

1. Pulls the last 48h of conversation messages, notes, and call
   transcripts for that contact from GHL.
2. Asks OpenAI to extract any address the contact stated about themselves.
3. Falls back to PropertyRadar (property records lookup) for any gaps
   extraction couldn't fill - including property type and square footage,
   which extraction can never provide on its own.
4. Writes only the genuinely missing fields back to the contact - it
   never overwrites a value GHL already has.

## What this does NOT do

- Batch/bulk processing. Built for one-off, human-triggered runs against
  a single contact at a time - not a scheduled job over your whole list.
- Auto-write without review. `DRY_RUN` and `PROPERTYRADAR_ALLOW_PURCHASE`
  let you see exactly what would happen before anything is written or
  any money is spent.

## Architecture

- `src/config.js` - env loading/validation. Resolves `.env` relative to
  this file's own location (not the terminal's current directory), so
  scripts work whether run from the project root or from inside `src/`.
- `src/ghlClient.js` - GHL REST API v2 calls: notes, conversations,
  messages, call transcription, contact update (incl. custom fields),
  and custom field discovery.
- `src/gatherSources.js` - filters notes/messages/transcripts to the
  configured lookback window (default 48h) and flags call-type messages
  for transcript retrieval.
- `src/extractAddress.js` - OpenAI extraction call; returns structured
  JSON with confidence and source excerpt.
- `src/propertyRadarClient.js` - PropertyRadar API client. Includes
  suffix-abbreviation normalization and a suffix-guessing fallback
  (confirmed empirically necessary - PropertyRadar's `Address` matching
  requires abbreviated street suffixes with any unit folded into the
  same string, e.g. `"3729 Balboa Ter Unit B"`, not `"3729 Balboa
  Terrace, Unit B"`). All guessing attempts use `Purchase=0` (free
  preview) - money is only spent on the single confirmed winning query,
  and only if `PROPERTYRADAR_ALLOW_PURCHASE=true`.
- `src/propertyTypeMapping.js` - maps PropertyRadar's property type
  fields to your GHL "Property Type" dropdown's exact option strings.
  Deliberately conservative: if nothing confidently maps, it leaves the
  field blank rather than guessing (e.g. a 10+ unit apartment building
  won't get miscategorized into a small multi-family bucket just because
  PropertyRadar's coarse `PType` code happens to say "MFR").
- `src/server.js` - the Express app and the two real endpoints
  (`/enrich-address`, `/health`) plus standalone test routes.
- `src/listCustomFields.js` - one-off script (not a server route) to
  look up your GHL location's custom field IDs.

## Setup

```bash
npm install
cp .env.example .env
# fill in every value in .env
npm run dev
```

### Required GHL Private Integration Token scopes

Settings > Private Integrations > Create New Integration, with:
- `contacts.readonly`, `contacts.write`
- `conversations.readonly`
- `conversations/message.readonly`

### Custom fields (optional)

Property type and square footage have no native GHL contact field - they
require custom fields. Run `node src/listCustomFields.js` to find the
`id`/`fieldKey` for your fields, then set:
```
GHL_CUSTOM_FIELD_ID_PROPERTY_TYPE=
GHL_CUSTOM_FIELD_KEY_PROPERTY_TYPE=
GHL_CUSTOM_FIELD_ID_SQFT=
GHL_CUSTOM_FIELD_KEY_SQFT=
```
If your "Property Type" field is a dropdown (`SINGLE_OPTIONS`), open
`src/propertyTypeMapping.js` and confirm `GHL_OPTIONS` matches your
dropdown's exact option strings, including any unusual spelling - a
`SINGLE_OPTIONS` field requires an exact string match to register.

## API

### `POST /enrich-address`

Header: `x-service-key: <your SERVICE_KEY>` (if set)

```json
{
  "contactId": "abc123",
  "address": "123 Main St",
  "city": "San Diego",
  "state": "CA",
  "zip": "",
  "propertyType": "",
  "sqft": ""
}
```

Pass whatever GHL already has - blank/omit anything missing. Response
includes `existing`, `extracted`, `propertyRadar` (full match/record if
the fallback ran), `wouldWrite` (what would be written, split into core
GHL fields and `customFields`), and `status`:
- `skipped` - nothing was missing
- `no_address_found` - checked everything, found nothing usable
- `dry_run_not_written` - found something, but `DRY_RUN=true`
- `written` - actually updated the contact (includes `ghlResponse`)

### `GET /health`

No auth required. Returns `{ ok: true }`.

### Standalone test routes (not part of the real flow)

- `POST /test-propertyradar` - raw PropertyRadar lookup, no normalization.
- `POST /test-propertyradar-smart` - suffix normalization + guessing,
  always free (`Purchase=0`).

## Cost controls

Two independent gates - neither implies the other:
- `DRY_RUN` (default `true`) - controls whether GHL actually gets written to.
- `PROPERTYRADAR_ALLOW_PURCHASE` (default `false`) - controls whether a
  confirmed PropertyRadar match is allowed to spend ~$0.02 to pull the
  full property record. Every failed/guessed attempt is always free
  regardless of this setting - only the one confirmed winning query costs
  anything, and only with this explicitly enabled.

## Deploying to Railway

1. Push this repo to GitHub (`.env` is gitignored - never commit it).
2. In Railway: New Project > Deploy from GitHub repo.
3. Add every variable from `.env` as a Railway environment variable
   (Settings > Variables). Use a long, random `SERVICE_KEY` in
   production - not a placeholder like `test123`, since this URL will be
   publicly reachable.
4. Railway runs `npm start` automatically (`node src/server.js`, no
   `--watch` - that's dev-only).
5. Once deployed, Railway gives you a public URL like
   `https://your-service.up.railway.app`. Your real endpoint is
   `https://your-service.up.railway.app/enrich-address`.
6. Decide your production defaults for `DRY_RUN` and
   `PROPERTYRADAR_ALLOW_PURCHASE` before anyone but you can trigger this -
   consider leaving `DRY_RUN=true` for an initial trial period even in
   production, so you can review a batch of real responses before
   trusting it to write unattended.

## Wiring up a GHL Workflow to call it

1. In GHL: Automation > Workflows > Create Workflow.
2. Pick whatever trigger fits your process (a tag added, a manual
   "Add to Workflow" action, a form submission, a pipeline stage change).
3. Add a **Webhook** action.
   - URL: `https://your-service.up.railway.app/enrich-address`
   - Method: `POST`
   - Headers: add `x-service-key` with your production `SERVICE_KEY`
     value, and `Content-Type: application/json`.
   - Body (JSON), using GHL's merge-field picker for each value -
     confirm the exact merge tag names in your account's picker, as
     these can vary by GHL version:
     ```json
     {
       "contactId": "{{contact.id}}",
       "address": "{{contact.address1}}",
       "city": "{{contact.city}}",
       "state": "{{contact.state}}",
       "zip": "{{contact.postal_code}}",
       "propertyType": "{{contact.property_type}}",
       "sqft": "{{contact.square_footage}}"
     }
     ```
4. Save and test the workflow against one real contact first, with
   `DRY_RUN=true` still set on the service, before enabling it broadly.

## Known gotchas (from real debugging)

- **Stray node processes on Windows**: `Ctrl+C` doesn't always fully kill
  `node --watch`. If env var changes don't seem to take effect after a
  restart, check what's actually bound to the port:
  `Get-NetTCPConnection -LocalPort 3000`, and compare against
  `Get-Process node` (which may also show unrelated VS Code background
  processes - not everything listed there is your server).
- **PowerShell + curl**: use `Invoke-RestMethod`, not `curl` (which is
  aliased to `Invoke-WebRequest` and doesn't accept curl-style flags).
- **File casing on Windows vs. Linux**: Windows is case-insensitive,
  Railway's Linux containers are not. Double-check exact filename casing
  matches your `import` statements before deploying.