import { KEYS, ALIASES, COMMON_INTENTS, OS_OVERRIDES } from './keymap.js';

function normalizeKey(k) {
  if (!k) return null;
  const key = ALIASES[k.toLowerCase()] || k;
  const found = KEYS.find(item => item.label === key);
  return found ? found.label : null;
}

export async function inferShortcut(text, { os = 'windows', env = window.ENV } = {}) {
  const cleaned = text.trim();
  if (!cleaned) return { keys: [], action: 'unknown', confidence: 0 };

  if (env && env.LLM_API_KEY) {
    try {
      const body = {
        model: env.LLM_MODEL || 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You extract keyboard shortcuts. Return only JSON {"keys":["Ctrl","W"],"action":"close_tab","confidence":0.9}'
          },
          { role: 'user', content: cleaned }
        ],
        response_format: { type: 'json_object' }
      };
      const res = await fetch((env.LLM_BASE_URL || 'https://api.openai.com') + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.LLM_API_KEY}`
        },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      const msg = data?.choices?.[0]?.message?.content;
      if (msg) {
        const parsed = JSON.parse(msg);
        if (Array.isArray(parsed.keys)) {
          const keys = parsed.keys.map(normalizeKey).filter(Boolean);
          if (keys.length) {
            return { keys, action: parsed.action || 'unknown', confidence: parsed.confidence ?? 0 };
          }
        }
      }
    } catch (err) {
      console.warn('LLM error', err);
    }
  }

  const lower = cleaned.toLowerCase();
  const intent = Object.keys(COMMON_INTENTS).find(k => lower.includes(k));
  if (intent) {
    let keys = COMMON_INTENTS[intent];
    if (os === 'macos' && OS_OVERRIDES.macos[intent]) {
      keys = OS_OVERRIDES.macos[intent];
    }
    return { keys, action: intent.replace(/\s+/g, '_'), confidence: 0 };
  }
  return { keys: [], action: 'unknown', confidence: 0 };
}
