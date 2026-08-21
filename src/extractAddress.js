import OpenAI from 'openai';
import { config } from './config.js';

const openai = new OpenAI({ apiKey: config.openai.apiKey });

const SYSTEM_PROMPT = `You extract US mailing addresses that a contact explicitly stated about themselves, from CRM conversation history, notes, and call transcripts.

Rules:
- Only extract an address the CONTACT stated as their own. Do not use an address mentioned about a third party, a business, or a meeting location unless it is clearly the contact's own address.
- Do not infer or complete a partial address. If the source only gives a city, or only a street with no city, report exactly what is present and leave other fields null - do not guess.
- Normalize the street address: expand common abbreviations (St -> Street, Ave -> Avenue, Rd -> Road, N/S/E/W -> North/South/East/West) unless doing so would change the meaning. Put any unit/apartment number in address_2, not address_1.
- If multiple different addresses are mentioned, prefer the most recent one (sources are ordered most-recent-first) unless an earlier one is clearly corrected by context (e.g. "actually my new address is...").
- sourceExcerpt must be the exact text the address came from, 15 words or fewer.

Respond with ONLY this JSON object, no other text:
{
  "found": boolean,
  "address_1": string|null,
  "address_2": string|null,
  "city": string|null,
  "state": string|null,
  "postal_code": string|null,
  "sourceType": "conversation"|"note"|"call_transcript"|null,
  "sourceExcerpt": string|null,
  "confidence": "high"|"medium"|"low"|null
}`;

function buildUserPrompt(entries, existing) {
  const sourceBlock = entries
    .map(
      (e, i) =>
        `[${i + 1}] (${e.sourceType}, ${e.timestamp})\n${e.text}`
    )
    .join('\n\n---\n\n');

  return `The contact record currently has these address fields on file (may be partial/empty):
${JSON.stringify(existing, null, 2)}

Here are the last ${entries.length} source excerpts from the contact's conversation history, notes, and call transcripts, most recent first:

${sourceBlock || '(no sources found in the lookback window)'}

Extract any address the contact stated about themselves, per the rules in your instructions.`;
}

/**
 * Calls OpenAI to extract a stated address from the gathered source entries.
 * Returns the parsed JSON object described in SYSTEM_PROMPT.
 */
export async function extractAddress(entries, existingFields) {
  if (entries.length === 0) {
    return {
      found: false,
      address_1: null,
      address_2: null,
      city: null,
      state: null,
      postal_code: null,
      sourceType: null,
      sourceExcerpt: null,
      confidence: null,
    };
  }

  const completion = await openai.chat.completions.create({
    model: config.openai.model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(entries, existingFields) },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content;
  if (!raw) {
    throw new Error('OpenAI response contained no message content');
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse extraction JSON: ${err.message}\nRaw: ${raw}`);
  }
}