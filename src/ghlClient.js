import { config } from './config.js';

const BASE = config.ghl.apiBase;

function headers(extra = {}) {
  return {
    Authorization: `Bearer ${config.ghl.pitToken}`,
    Version: config.ghl.apiVersion,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function ghlFetch(path, { method = 'GET', body, query } = {}) {
  const url = new URL(BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
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
      `GHL API ${method} ${path} failed: ${res.status} ${JSON.stringify(json)}`
    );
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return json;
}

/**
 * Get all notes for a contact.
 * Returns raw note objects: { id, body, dateAdded, userId, ... }
 */
export async function getAllNotes(contactId) {
  const res = await ghlFetch(`/contacts/${contactId}/notes`);
  return res.notes || [];
}

/**
 * Find conversation(s) tied to a contact.
 */
export async function searchConversationsByContact(contactId) {
  const res = await ghlFetch('/conversations/search', {
    query: { contactId, limit: 20, sort: 'desc', sortBy: 'last_message_date' },
  });
  return res.conversations || [];
}

/**
 * Get messages for a single conversation.
 * limit is generous since we filter by date client-side afterward.
 */
export async function getMessages(conversationId, limit = 100) {
  const res = await ghlFetch(`/conversations/${conversationId}/messages`, {
    query: { limit },
  });
  return res.messages?.messages || res.messages || [];
}

/**
 * Get the call transcription for a single message.
 * Returns null (not throws) if no transcription exists for that message,
 * since that's an expected, common case (not every call gets transcribed).
 */
export async function getMessageTranscription(messageId, locationId) {
  try {
    const res = await ghlFetch(
      `/conversations/locations/${locationId}/messages/${messageId}/transcription`
    );
    return res;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Get all custom field definitions for the location. Each entry includes
 * both `id` (the internal ID needed to write values) and `fieldKey`
 * (the {{contact.field_key}} merge-tag format).
 */
export async function getCustomFields(locationId) {
  const res = await ghlFetch(`/locations/${locationId}/customFields`);
  return res.customFields || [];
}

/**
 * Write the resolved address fields (and optionally custom fields, e.g.
 * property type / sqft) back onto the contact. Only includes fields that
 * are actually present - avoids nulling out anything untouched.
 *
 * customFields: array of { id, fieldValue } - the `id` must be a real
 * custom field ID from this GHL location (GET /locations/{locationId}/
 * customFields). Entries without a resolvable id should be filtered out
 * by the caller before this is invoked - this function just passes
 * through whatever it's given.
 */
export async function updateContactAddress(contactId, { address1, city, state, postalCode, customFields }) {
  const body = {};
  if (address1) body.address1 = address1;
  if (city) body.city = city;
  if (state) body.state = state;
  if (postalCode) body.postalCode = postalCode;
  if (customFields && customFields.length > 0) {
    body.customFields = customFields.map(({ id, key, fieldValue }) => ({
      id,
      ...(key ? { key } : {}),
      fieldValue,
    }));
  }

  if (Object.keys(body).length === 0) {
    throw new Error('updateContactAddress called with no fields to update');
  }

  return ghlFetch(`/contacts/${contactId}`, { method: 'PUT', body });
}