// Turns a song into a 1-10 mood score: Last.fm tags first, LLM rating as fallback.

// Starting tag weights from the project plan (tune later).
const TAG_POINTS = {
  happy: 2, 'feel good': 2, upbeat: 2, party: 2,
  summer: 1, fun: 1, dance: 1, energetic: 1,
  chill: 0, mellow: 0,
  melancholy: -1, lonely: -1, heartbreak: -1,
  sad: -2, depressing: -2,
};

// Score = 5.5 + 2.25 * average points of matched tags. Returns null when no tag matches.
function scoreFromTags(tags) {
  const points = tags
    .map((t) => t.toLowerCase())
    .filter((t) => t in TAG_POINTS)
    .map((t) => TAG_POINTS[t]);
  if (points.length === 0) return null;
  const avg = points.reduce((a, b) => a + b, 0) / points.length;
  const score = 5.5 + 2.25 * avg;
  return Math.round(Math.min(10, Math.max(1, score)) * 10) / 10;
}

async function fetchTopTags(artist, track, apiKey) {
  const params = new URLSearchParams({
    method: 'track.getTopTags', artist, track, api_key: apiKey, format: 'json', autocorrect: '1',
  });
  const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`);
  if (!res.ok) return [];
  const data = await res.json();
  return [].concat(data?.toptags?.tag ?? []).map((t) => t.name);
}

// Asks Claude for a 1-10 rating. Returns null if the reply is not a usable number.
async function llmScore(artist, track, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-5-5',
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: `Rate the mood of the song "${track}" by ${artist} on a 1-10 scale, where 1 is very sad and 10 is very happy. Reply with only the number.`,
      }],
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const n = parseFloat(data?.content?.[0]?.text);
  if (Number.isNaN(n)) return null;
  return Math.round(Math.min(10, Math.max(1, n)) * 10) / 10;
}

// Returns { score, source } where source is 'lastfm' | 'llm', or { score: null, source: null }.
async function scoreTrack({ artist, track, lastfmKey, anthropicKey }) {
  const tags = await fetchTopTags(artist, track, lastfmKey);
  const fromTags = scoreFromTags(tags);
  if (fromTags !== null) return { score: fromTags, source: 'lastfm' };
  // shortcut: no LLM call when no key is set, upgrade by adding ANTHROPIC_API_KEY
  if (!anthropicKey) return { score: null, source: null };
  const fromLlm = await llmScore(artist, track, anthropicKey);
  return fromLlm === null ? { score: null, source: null } : { score: fromLlm, source: 'llm' };
}

function moodEmoji(score) {
  if (score >= 8) return '😄';
  if (score >= 6) return '🙂';
  if (score >= 4) return '😐';
  if (score >= 2) return '😔';
  return '😢';
}

module.exports = { scoreFromTags, scoreTrack, moodEmoji, TAG_POINTS };
