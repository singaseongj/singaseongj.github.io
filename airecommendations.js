import { writeFile } from 'node:fs/promises';

const OUTPUT_FILE = 'aiselected.json';
const API_KEY = process.env.GPT_API;
const MODEL = process.env.GPT_MODEL || 'gpt-4o-mini';
const ENDPOINT = process.env.GPT_API_ENDPOINT || 'https://api.openai.com/v1/chat/completions';

const PROMPT = `Fetch 10 currently trendy publicly traded companies: 5 from the Korean stock market and 5 from the New York stock market. 

Use recent market attention, news momentum, trading interest, sector trend, or investor discussion as the basis for “trendy.”

Return only valid JSON. Do not include markdown, explanations, or comments.

JSON format:
{
  "korean_market": [
    {
      "company_name": "",
      "ticker": "",
      "exchange": "",
      "reason_trendy": ""
    }
  ],
  "new_york_market": [
    {
      "company_name": "",
      "ticker": "",
      "exchange": "",
      "reason_trendy": ""
    }
  ]
}`;

function requireApiKey() {
  if (!API_KEY || !API_KEY.trim()) {
    throw new Error('GPT_API environment secret is required to generate aiselected.json');
  }
}

function stripCodeFence(text) {
  return text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function assertMarketItems(items, marketName) {
  if (!Array.isArray(items) || items.length !== 5) {
    throw new Error(`${marketName} must contain exactly 5 companies`);
  }

  for (const [index, item] of items.entries()) {
    for (const key of ['company_name', 'ticker', 'exchange', 'reason_trendy']) {
      if (typeof item?.[key] !== 'string' || !item[key].trim()) {
        throw new Error(`${marketName}[${index}].${key} must be a non-empty string`);
      }
    }
  }
}

function validateSelection(selection) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    throw new Error('AI response must be a JSON object');
  }

  assertMarketItems(selection.korean_market, 'korean_market');
  assertMarketItems(selection.new_york_market, 'new_york_market');

  return {
    korean_market: selection.korean_market.map(({ company_name, ticker, exchange, reason_trendy }) => ({
      company_name: company_name.trim(),
      ticker: ticker.trim(),
      exchange: exchange.trim(),
      reason_trendy: reason_trendy.trim(),
    })),
    new_york_market: selection.new_york_market.map(({ company_name, ticker, exchange, reason_trendy }) => ({
      company_name: company_name.trim(),
      ticker: ticker.trim(),
      exchange: exchange.trim(),
      reason_trendy: reason_trendy.trim(),
    })),
  };
}

async function requestAiSelection() {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You return current market-trend stock selections as strict JSON only.',
        },
        { role: 'user', content: PROMPT },
      ],
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GPT API request failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
  }

  const parsed = JSON.parse(body);
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('GPT API response did not include message content');
  }

  return validateSelection(JSON.parse(stripCodeFence(content)));
}

async function main() {
  requireApiKey();
  const selection = await requestAiSelection();
  await writeFile(OUTPUT_FILE, `${JSON.stringify(selection, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${OUTPUT_FILE} with ${selection.korean_market.length + selection.new_york_market.length} AI-selected companies.`);
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
