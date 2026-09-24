/**
 * Local-LLM receipt classification via Ollama (http://127.0.0.1:11434 by
 * default). Runs entirely on this machine -- no receipt data leaves the
 * device. Used by extraction.js as an upgrade over plain keyword regex:
 * given a receipt image (vision) or extracted text, asks the model to read
 * it, pick which of the company's 4 fixed spend categories it belongs to,
 * and pick (or, if nothing fits, propose) one or more tags within that
 * category for finer-grained reporting.
 *
 * The category set is CLOSED (exactly 4 -- Office Expenses, Professional
 * Development, Business Development, Team Engagement/Employee Retention,
 * see constants.js) and every expense fits one of them, so unlike the old
 * ~38-category version, there's no "propose a new category" concept
 * anymore -- only tags (the finer-grained label within a category) can be
 * proposed when nothing existing fits.
 *
 * Fully optional and fails soft: if Ollama isn't running, the model isn't
 * pulled, or the response isn't parseable, both classify functions return
 * null/empty and extraction.js falls back to the original heuristics.
 */
const fs = require('fs');
const db = require('../db');

const OLLAMA_ENABLED = String(process.env.OLLAMA_ENABLED || 'false').toLowerCase() === 'true';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2-vision:11b';
// Text-only classification (spreadsheet rows, extracted PDF text) never
// needs vision -- a model actually built for instruction-following/JSON
// output does noticeably better at this than a vision-tuned model asked to
// do pure reasoning. Falls back to OLLAMA_MODEL if unset, so this stays
// optional.
const OLLAMA_TEXT_MODEL = process.env.OLLAMA_TEXT_MODEL || OLLAMA_MODEL;
// CPU-only inference on a machine with no dedicated GPU can take a while,
// especially the first call after the server starts (model has to load into
// RAM). Generous default so a slow-but-working answer isn't mistaken for a
// hang.
const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || '120000', 10);

// A tag choosing one of these names is treated as linking the expense to
// the Marketing & ROI event tracker -- computed deterministically from the
// tag rather than asked of the model separately, since the tag already
// implies it.
const TAG_TO_EVENT_TYPE = {
  Events: 'networking',
  Conferences: 'conference',
  Sponsorships: 'sponsorship',
};

function loadCategoriesWithTags() {
  const categories = db.prepare('SELECT id, name, kind, recurrence_basis FROM categories ORDER BY name').all();
  const tags = db.prepare('SELECT id, name, category_id FROM tags ORDER BY name').all();
  return categories.map((c) => ({ ...c, tags: tags.filter((t) => t.category_id === c.id) }));
}

function stripJsonFences(raw) {
  const trimmed = String(raw || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : trimmed;
}

async function callOllamaChat(messages, model = OLLAMA_MODEL) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, format: 'json' }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.message ? data.message.content : null;
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function categoryBlock(categories) {
  return categories
    .map((c) => `- "${c.name}"\n  Tags: ${c.tags.map((t) => `"${t.name}"`).join(', ') || '(none yet)'}`)
    .join('\n');
}

// Shared prose (not JSON) explaining how to pick category/tags -- embedded
// into both prompt builders below, each of which wraps it in its own JSON
// schema shape (a single object vs. a "results" array).
function categoryTagRules(categories) {
  return `The 4 categories and their existing tags:
${categoryBlock(categories)}

How to decide "category" and "tags":
1. Pick exactly ONE category from the list above -- it's a closed set of these 4, always pick the best fit, never invent a 5th.
2. Within that category, pick one or more of ITS OWN existing tags (never a tag listed under a different category) that describe this purchase. Prefer reusing an existing tag over inventing one -- a tag doesn't need to be a perfect semantic match, just a sensible practical fit.
3. Only propose a new tag name (is_new: true) if none of that category's existing tags reasonably cover it, AND this represents a repeatable kind of purchase (not a one-off oddity -- a single unusual item should go under the closest existing tag instead, even if imperfect).
4. Every "tags" entry must include "is_new": true only for a genuinely new tag; false for an existing one, matching its exact existing name.`;
}

// `imagePath` (for image receipts) and `text` (OCR/PDF-text fallback, or
// extra context alongside the image) are both optional but at least one
// should be present for a useful result.
async function classifyReceiptWithAI({ imagePath, text }) {
  if (!OLLAMA_ENABLED) return null;

  const categories = loadCategoriesWithTags();
  const systemPrompt = `You read a single company purchase receipt (image or extracted text) and return ONE JSON object -- nothing else, no markdown fences, no commentary.

Schema (all keys required):
{
  "vendor": string or null,
  "date": "YYYY-MM-DD" string or null,
  "amount": number or null (the total charged, not a subtotal or a line item),
  "description": short string or null (what was purchased),
  "category": one of ${JSON.stringify(categories.map((c) => c.name))},
  "tags": [ { "name": string, "is_new": boolean }, ... ]  // at least one
}

${categoryTagRules(categories)}

Return ONLY the JSON object.`;

  const userContent = imagePath
    ? 'Read this receipt image and return the JSON object described above.'
    : `Here is the extracted text of a receipt/statement:\n\n${(text || '').slice(0, 6000)}\n\nReturn the JSON object described above.`;

  const userMessage = { role: 'user', content: userContent };
  if (imagePath) {
    try {
      userMessage.images = [fs.readFileSync(imagePath).toString('base64')];
    } catch (err) {
      return null;
    }
  }

  const raw = await callOllamaChat(
    [{ role: 'system', content: systemPrompt }, userMessage],
    imagePath ? OLLAMA_MODEL : OLLAMA_TEXT_MODEL
  );
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(stripJsonFences(raw));
  } catch (err) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const result = resolveClassification(parsed, categories);
  if (!result) return null;

  return {
    vendor: typeof parsed.vendor === 'string' && parsed.vendor.trim() ? parsed.vendor.trim().slice(0, 120) : null,
    date: typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : null,
    amount: Number.isFinite(parsed.amount) ? parsed.amount : null,
    description: typeof parsed.description === 'string' && parsed.description.trim() ? parsed.description.trim().slice(0, 500) : null,
    ...result,
  };
}

// Resolves a raw {category, tags} model response against the real
// category/tag list -- shared by both the single-receipt and batch paths.
// Returns null if the model didn't name a real category at all.
function resolveClassification(parsed, categories) {
  const categoryName = typeof parsed.category === 'string' ? parsed.category.trim() : '';
  const category = categories.find((c) => c.name.toLowerCase() === categoryName.toLowerCase());
  if (!category) return null;

  const rawTags = Array.isArray(parsed.tags) ? parsed.tags : [];
  const tags = [];
  for (const rt of rawTags) {
    const name = typeof rt === 'string' ? rt : typeof rt?.name === 'string' ? rt.name : '';
    if (!name.trim()) continue;
    const existing = category.tags.find((t) => t.name.toLowerCase() === name.trim().toLowerCase());
    tags.push({ name: existing ? existing.name : name.trim().slice(0, 60), is_new: !existing });
  }
  // De-dupe by name (case-insensitive) in case the model listed the same tag twice.
  const seen = new Set();
  const dedupedTags = tags.filter((t) => {
    const key = t.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!dedupedTags.length) return null;

  const eventTag = dedupedTags.find((t) => TAG_TO_EVENT_TYPE[t.name] && !t.is_new);

  return {
    suggested_category: category.name,
    suggested_kind: category.kind,
    suggested_recurrence_basis: category.recurrence_basis,
    tags: dedupedTags,
    suggested_event_type: eventTag ? TAG_TO_EVENT_TYPE[eventTag.name] : null,
    suggest_one_time: category.recurrence_basis === 'one-time',
  };
}

// Batch text-only classification for spreadsheet/CSV imports (e.g. a
// Capital One or Amazon order-history export) where vendor/date/amount
// already come from reliable source columns and only the CATEGORY/TAG
// judgment is worth an LLM's attention -- one item at a time would take
// hours at this model's CPU-only speed, so items are classified BATCH_SIZE
// at a time in one call.
const BATCH_SIZE = 12;

function buildBatchSystemPrompt(categories) {
  return `You classify a batch of purchased items (from an order history export) into the company's spend categories/tags. Return ONE JSON object -- nothing else, no markdown fences, no commentary.

Schema:
{
  "results": [
    {
      "index": number,
      "category": one of ${JSON.stringify(categories.map((c) => c.name))},
      "tags": [ { "name": string, "is_new": boolean }, ... ]  // at least one
    },
    ...
  ]
}

Return exactly one result per input item, "index" copied from the input so results can be matched back up, in any order.

${categoryTagRules(categories)}`;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Crude singularizer good enough to catch "Battery" vs "Batteries" as the
// same normalized key, without a real NLP dependency.
function normalizeTagKey(name) {
  let n = name.trim().toLowerCase().replace(/\s+/g, ' ');
  if (n.endsWith('ies')) n = n.slice(0, -3) + 'y';
  else if (n.endsWith('es')) n = n.slice(0, -2);
  else if (n.endsWith('s') && !n.endsWith('ss')) n = n.slice(0, -1);
  return n;
}

// items: [{ index, description, amount }]. Returns a Map<index, result>
// (result shaped like classifyReceiptWithAI's category/tag fields) for
// every item that classified successfully -- an item missing from the map
// (a whole chunk's call failed, its own entry didn't parse, or it named no
// real category) is left for the caller to fall back to the regex
// heuristic for, rather than failing the whole batch.
//
// Each chunk is classified independently -- earlier chunks' proposed-new
// TAGS are deliberately NOT fed into later chunks' prompts, for the same
// reason the old category version of this avoided it: doing so let one bad
// proposal snowball into every later chunk reusing it. Cross-chunk
// consistency for genuinely repeated new tags is instead handled
// deterministically after the fact, below (normalized-name merge).
async function classifyDescriptionsBatch(items) {
  const results = new Map();
  if (!OLLAMA_ENABLED || !items.length) return results;

  const categories = loadCategoriesWithTags();
  const systemPrompt = buildBatchSystemPrompt(categories);

  for (const group of chunk(items, BATCH_SIZE)) {
    const userContent = `Items:\n${JSON.stringify(
      group.map((it) => ({ index: it.index, description: it.description, amount: it.amount }))
    )}\n\nReturn the JSON object described above, one result per item.`;

    const raw = await callOllamaChat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      OLLAMA_TEXT_MODEL
    );
    if (!raw) continue;

    let parsed;
    try {
      parsed = JSON.parse(stripJsonFences(raw));
    } catch (err) {
      continue;
    }
    if (!parsed || !Array.isArray(parsed.results)) continue;

    for (const r of parsed.results) {
      const idx = Number(r.index);
      if (!Number.isInteger(idx)) continue;
      const resolved = resolveClassification(r, categories);
      if (resolved) results.set(idx, resolved);
    }
  }

  // Deterministic cross-chunk merge for NEW tags: group by normalized name
  // (within the same category, since two different categories could
  // legitimately propose similarly-worded tags) and collapse each group
  // onto whichever full name was proposed first.
  const canonicalByKey = new Map();
  for (const result of results.values()) {
    for (const tag of result.tags) {
      if (!tag.is_new) continue;
      const key = `${result.suggested_category}::${normalizeTagKey(tag.name)}`;
      if (!canonicalByKey.has(key)) canonicalByKey.set(key, tag.name);
    }
  }
  for (const result of results.values()) {
    for (const tag of result.tags) {
      if (!tag.is_new) continue;
      tag.name = canonicalByKey.get(`${result.suggested_category}::${normalizeTagKey(tag.name)}`);
    }
  }

  return results;
}

module.exports = { classifyReceiptWithAI, classifyDescriptionsBatch, OLLAMA_ENABLED, TAG_TO_EVENT_TYPE };
