'use strict';
// Sends OS push notifications through Expo's push service.
// Content is always generic (names + event type only) — message text, captions
// and media are E2E encrypted and the server never sees plaintext to send.
const db = require('./db/sqlite');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

async function send(memberNames, title, body, data = {}) {
  const tokens = db.getPushTokens(memberNames);
  if (!tokens.length) return;
  const messages = tokens.map((t) => ({ to: t.token, title, body, data, sound: 'default' }));
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk),
      });
      const json = await res.json().catch(() => ({}));
      (json.data || []).forEach((ticket, idx) => {
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered')
          db.deletePushToken(chunk[idx].to);
      });
    } catch (e) {
      console.error('[push] send failed:', e.message);
    }
  }
}

// Fire-and-forget — request handlers never wait on the Expo API
function notify(memberNames, title, body, data) {
  if (!memberNames.length) return;
  send(memberNames, title, body, data).catch((e) => console.error('[push]', e.message));
}

module.exports = { notify };
