import 'dotenv/config';
import express from 'express';
import Groq from 'groq-sdk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Image sources ────────────────────────────────────────────────────────────

async function fetchPexelsImage(query) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return null;
  try {
    const q = encodeURIComponent(query);
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${q}&per_page=1&orientation=portrait&size=large`,
      { headers: { Authorization: key }, signal: AbortSignal.timeout(5000) }
    );
    const data = await res.json();
    return data?.photos?.[0]?.src?.large2x ?? data?.photos?.[0]?.src?.large ?? null;
  } catch {
    return null;
  }
}

// Scrape the image from Amazon's top-reviewed listing for the search term.
// Works from a residential/local IP; cloud IPs may get bot-checked.
async function fetchAmazonTopImage(searchTerms) {
  try {
    const q = encodeURIComponent(searchTerms);
    const res = await fetch(`https://www.amazon.com/s?k=${q}&sort=review-rank`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'sec-ch-ua': '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return null;
    const html = await res.text();

    // Amazon embeds image URLs in multiple ways — try each in order
    const patterns = [
      // Primary: s-image class on search result cards
      /class="s-image"[^>]*src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/,
      /src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"[^>]*class="s-image"/,
      // JSON blob embedded in page data
      /"large"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/,
      /"hiRes"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/,
      // Any m.media-amazon.com product image
      /(https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9%+_-]{10,}\.(jpg|jpeg|png|webp))/,
    ];

    for (const pat of patterns) {
      const match = html.match(pat);
      if (match?.[1]) {
        // Strip the size suffix (e.g. ._AC_SL500_.) to get the full-res image
        return match[1].replace(/\._[A-Za-z0-9_,]+_\./, '.');
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Parse the lowest dollar amount mentioned in a price string, e.g. "~$45–$65" → 45
function parsePriceFloor(priceStr = '') {
  const nums = [...priceStr.matchAll(/[\d,]+(?:\.\d+)?/g)].map(m => parseFloat(m[0].replace(',', '')));
  return nums.length ? Math.min(...nums) : null;
}

function buildPrompt(recipient, occasion, budgetMin, budgetMax, seenLine, likedLine, dislikedLine, extraNote = '') {
  return `You are a gift recommendation expert with accurate knowledge of current retail prices.
Suggest ONE specific gift product available on Amazon.

Recipient: ${recipient}${occasion ? `\nOccasion: ${occasion}` : ''}
STRICT budget: $${budgetMin}–$${budgetMax}${seenLine}${likedLine}${dislikedLine}${extraNote}

Pricing rules — these are mandatory:
1. The product's real retail price on Amazon MUST fall between $${budgetMin} and $${budgetMax}.
2. Before answering, mentally verify: "Does this product actually cost $${budgetMin}–$${budgetMax} on Amazon right now?" If not, pick a different product.
3. "price" must be a tight, accurate estimate based on your real training-data knowledge — e.g. "~$49" or "$45–$55". Do NOT write a wide range like "$20–$100".
4. Do NOT suggest products you are uncertain about the price of — choose something common with well-known pricing.

Other rules:
- Be specific — a real, named product type easily found on Amazon.
- Tailor suggestion to the recipient description.
- Use liked/disliked history to refine the choice.
- "description" must be ONE sentence, max 18 words, stating the product's standout quality. No phrases like "perfect gift" or "they will love".

Respond with ONLY valid JSON, no markdown, no explanation:
{
  "name": "Specific product name",
  "description": "One punchy sentence (max 18 words) naming the product's single best quality for this recipient. No filler.",
  "price": "Accurate retail price, e.g. '~$49' or '$45–$55'",
  "category": "Short category (e.g. Books, Gadgets, Kitchen, Beauty, Outdoors)",
  "emoji": "Single relevant emoji",
  "searchTerms": "Best Amazon search query for this product",
  "photoKeywords": "2–4 words for a lifestyle photo search, e.g. 'wireless headphones music'"
}`;
}

app.post('/api/suggest', async (req, res) => {
  const { occasion = '', recipient, budgetMin, budgetMax, previousSuggestions = [], liked = [], disliked = [] } = req.body;

  if (!recipient || !budgetMin || !budgetMax) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const seenLine     = previousSuggestions.length > 0 ? `\nAlready shown (do not repeat): ${previousSuggestions.join('; ')}.` : '';
  const likedLine    = liked.length    > 0 ? `\nLIKED (similar vein): ${liked.join('; ')}.` : '';
  const dislikedLine = disliked.length > 0 ? `\nDISLIKED (avoid): ${disliked.join('; ')}.` : '';

  async function callGroq(prompt) {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 700,
    });
    const raw   = response.choices[0].message.content.trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in response');
    return JSON.parse(match[0]);
  }

  try {
    // First attempt
    let gift = await callGroq(buildPrompt(recipient, occasion, budgetMin, budgetMax, seenLine, likedLine, dislikedLine));

    // If the price floor is clearly above budget, retry once with a stronger nudge
    const floor = parsePriceFloor(gift.price);
    if (floor !== null && floor > budgetMax) {
      console.log(`Price floor $${floor} exceeds budget $${budgetMax} — retrying with tighter constraint`);
      const note = `\nIMPORTANT: Your last suggestion ("${gift.name}" at ${gift.price}) exceeded the $${budgetMax} budget. Pick something genuinely cheaper.`;
      gift = await callGroq(buildPrompt(recipient, occasion, budgetMin, budgetMax, seenLine, likedLine, dislikedLine, note));
    }

    gift.amazonUrl = `https://www.amazon.com/s?k=${encodeURIComponent(gift.searchTerms)}&sort=review-rank`;

    // Pexels (if key set) → Amazon top-reviewed listing image
    gift.imageUrl = await fetchPexelsImage(gift.name)
      ?? await fetchAmazonTopImage(gift.searchTerms);

    console.log(`"${gift.name}" | ${gift.price} | img: ${gift.imageUrl ? gift.imageUrl.slice(0, 70) : 'emoji fallback'}`);
    res.json(gift);
  } catch (err) {
    console.error('Suggestion error:', err.message);
    res.status(500).json({ error: 'Could not fetch a suggestion. Please try again.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Gift Finder running at http://localhost:${PORT}`);
});
