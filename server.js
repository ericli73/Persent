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

// ── Product image: Serper image search ───────────────────────────────────────
// Shopping results return low-res thumbnails. This fetches a full-size product
// image from the source website instead. Runs in parallel with the shopping call.
async function fetchProductImage(searchTerms) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch('https://google.serper.dev/images', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: searchTerms, num: 5 }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Prefer full-size images — skip Google's encrypted-tbn thumbnails
    const img = data?.images?.find(i =>
      i.imageUrl && !i.imageUrl.includes('encrypted-tbn') &&
      (i.imageWidth >= 400 || i.imageHeight >= 400)
    ) || data?.images?.find(i => i.imageUrl && !i.imageUrl.includes('encrypted-tbn'))
      || data?.images?.[0];
    return img?.imageUrl ?? null;
  } catch {
    return null;
  }
}

// ── Product lookup via Google Shopping (Serper.dev) ──────────────────────────
// Returns the top Google Shopping result: exact name, price, image, and a direct
// link to the retailer's product page (Amazon, Walmart, Best Buy, etc.).
// Free tier: 2500 searches. Sign up at serper.dev. Needs SERPER_API_KEY in .env.
async function fetchRetailerProduct(searchTerms, budgetMin, budgetMax) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return null;
  try {
    const q = budgetMax ? `${searchTerms} under $${budgetMax}` : searchTerms;
    const res = await fetch('https://google.serper.dev/shopping', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, num: 5 }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) { console.error('Serper error:', res.status); return null; }
    const data = await res.json();

    const items = (data?.shopping || []).filter(i => i.price && i.imageUrl);
    if (!items.length) { console.log('Serper: no result for', searchTerms); return null; }

    // Prefer first item within budget; fall back to cheapest available
    const parsePrice = s => parseFloat((s || '').replace(/[^0-9.]/g, ''));
    const inBudget = items.filter(i => {
      const p = parsePrice(i.price);
      return p > 0 && p <= budgetMax && (!budgetMin || p >= budgetMin * 0.4);
    });
    const item = inBudget[0] || items.sort((a, b) => parsePrice(a.price) - parsePrice(b.price))[0];

    console.log(`Serper: "${(item.title || '').slice(0, 50)}" | ${item.price} | ${item.source}`);
    return {
      name:       item.title    || null,
      price:      item.price    || null,
      imageUrl:   item.imageUrl || null,
      productUrl: item.link     || null,
      retailer:   item.source   || 'Shop',
    };
  } catch (e) {
    console.error('Serper error:', e.message);
    return null;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Proxy external product images to bypass hotlink protection on retailer sites.
app.get('/api/image-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).end();
  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Referer': new URL(url).origin + '/',
        'Accept': 'image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) return res.status(404).end();
    const buffer = await upstream.arrayBuffer();
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(buffer));
  } catch (e) {
    console.error('Image proxy:', e.message);
    res.status(500).end();
  }
});

function buildPrompt(recipient, occasion, budgetMin, budgetMax, seenLine, likedLine, dislikedLine) {
  return `You are a gift recommendation expert.
Suggest ONE specific gift product for the recipient below.

Recipient: ${recipient}${occasion ? `\nOccasion: ${occasion}` : ''}
Budget: $${budgetMin}–$${budgetMax}${seenLine}${likedLine}${dislikedLine}

Rules:
- VARIETY IS MANDATORY: every suggestion must be a different category from all previously shown and liked items. Never cluster.
- Use liked items only to understand taste — never repeat the same product type.
- "searchTerms" must be a specific, searchable product query (e.g. "Sony WH-1000XM5 wireless headphones", not "headphones").
- "description" must be ONE sentence, max 15 words, on the product's standout quality.

Respond with ONLY valid JSON (no extra text):
{"name":"Short product type name","description":"One punchy sentence.","category":"Short category","emoji":"Single emoji","searchTerms":"Specific search query"}`;
}

app.post('/api/suggest', async (req, res) => {
  const { occasion = '', recipient, budgetMin, budgetMax, previousSuggestions = [], liked = [], disliked = [] } = req.body;

  if (!recipient || !budgetMin || !budgetMax) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const seenLine     = previousSuggestions.length > 0 ? `\nAlready shown (do not repeat): ${previousSuggestions.join('; ')}.` : '';
  const likedLine    = liked.length    > 0 ? `\nLIKED so far (understand taste, never repeat category): ${liked.slice(-3).join('; ')}.` : '';
  const dislikedLine = disliked.length > 0 ? `\nDISLIKED (avoid): ${disliked.join('; ')}.` : '';

  async function callGroq(prompt) {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 150,
    });
    const raw   = response.choices[0].message.content.trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in response');
    return JSON.parse(match[0]);
  }

  try {
    const gift = await callGroq(buildPrompt(recipient, occasion, budgetMin, budgetMax, seenLine, likedLine, dislikedLine));

    // Both Serper calls run in parallel — shopping for price/name/link, images for HD photo
    const [product, hdImage] = await Promise.all([
      fetchRetailerProduct(gift.searchTerms, budgetMin, budgetMax),
      fetchProductImage(gift.searchTerms),
    ]);
    gift.price      = product?.price    ?? null;
    // HD image proxied through our server to bypass retailer hotlink protection
    gift.imageUrl   = hdImage
      ? `/api/image-proxy?url=${encodeURIComponent(hdImage)}`
      : product?.imageUrl ?? null;
    gift.productUrl = product?.productUrl ?? `https://www.amazon.com/s?k=${encodeURIComponent(gift.searchTerms)}&sort=review-rank`;
    gift.retailer   = product?.retailer ?? 'Amazon';
    if (product?.name) {
      const n = product.name;
      gift.name = n.length > 60 ? n.slice(0, n.lastIndexOf(' ', 60)) + '…' : n;
    }

    console.log(`"${gift.name}" | ${gift.price ?? 'no price'} | img: ${gift.imageUrl ? 'yes' : 'emoji fallback'} | ${gift.retailer}`);
    res.json(gift);
  } catch (err) {
    console.error('Suggestion error:', err.message);
    res.status(500).json({ error: 'Could not fetch a suggestion. Please try again.' });
  }
});

export default app;

// Only bind a port when running locally — Vercel uses the exported app directly
if (process.env.VERCEL !== '1') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Persent running at http://localhost:${PORT}`));
}
