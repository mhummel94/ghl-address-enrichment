import { config } from './config.js';
import {
  getAllNotes,
  searchConversationsByContact,
  getMessages,
  getMessageTranscription,
} from './ghlClient.js';

const LOOKBACK_MS = config.service.lookbackHours * 60 * 60 * 1000;

function withinLookback(timestamp) {
  if (!timestamp) return false;
  const t = new Date(timestamp).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= LOOKBACK_MS;
}

function isCallMessage(msg) {
  const t = (msg.messageType || msg.type || '').toString().toUpperCase();
  return t.includes('CALL');
}

/**
 * Pulls notes + conversation messages + call transcripts for a contact,
 * filtered to the configured lookback window (default 48h).
 *
 * Returns an array of { sourceType, timestamp, text } entries ready to
 * hand to the extraction prompt.
 */
export async function gatherSources(contactId, locationId) {
  const entries = [];

  // --- Notes ---
  const notes = await getAllNotes(contactId);
  for (const note of notes) {
    if (withinLookback(note.dateAdded) && note.body) {
      entries.push({
        sourceType: 'note',
        timestamp: note.dateAdded,
        text: note.body,
      });
    }
  }

  // --- Conversation messages (+ call transcripts) ---
  const conversations = await searchConversationsByContact(contactId);

  for (const convo of conversations) {
    const messages = await getMessages(convo.id);

    for (const msg of messages) {
      const timestamp = msg.dateAdded || msg.dateUpdated;
      if (!withinLookback(timestamp)) continue;

      if (isCallMessage(msg)) {
        // Pull transcript if one exists for this call.
        const transcript = await getMessageTranscription(msg.id, locationId);
        if (transcript?.transcription) {
          const text = Array.isArray(transcript.transcription)
            ? transcript.transcription.map((seg) => seg.transcript || seg.text || '').join(' ')
            : String(transcript.transcription);
          if (text.trim()) {
            entries.push({ sourceType: 'call_transcript', timestamp, text });
          }
        }
        continue;
      }

      // Regular SMS/email/webchat/etc body text
      const text = msg.body || msg.text;
      if (text && text.trim()) {
        entries.push({ sourceType: 'conversation', timestamp, text });
      }
    }
  }

  // Most recent first - if multiple addresses show up, we want the LLM
  // weighting the freshest mention.
  entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  return entries;
}
