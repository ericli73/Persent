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

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
};

async function fetchAmazonImage(searchTerms) {
  try {
    const url = `https://www.amazon.com/s?k=${encodeURIComponent(searchTerms)}`;
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    const html = await res.text();

    // Try several patterns Amazon uses for product images
    const patterns = [
      /class="s-image"[^>]*src="(https:\/\/m\.media-amazon\.com\/images\/[^"]+)"/,
      /src="(https:\/\/m\.media-amazon\.com\/images\/[^"]+)"[^>]*class="s-image"/,
      /"imageUrl"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/[^"]+)"/,
      /"hiRes"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/[^"]+)"/,
    ];

    for (const pat of patterns) {
      const match = html.match(pat);
      if (match) {
        // Upscale the image by stripping size modifiers
        return match[1].replace(/\._[^.]+_\./, '.');
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchWikipediaImage(searchTerms) {
  try {
    const query = encodeURIComponent(searchTerms.split(' ').slice(0, 3).join(' '));
    const url = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${query}&gsrlimit=5&prop=pageimages&pithumbsize=480&format=json&origin=*`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    const pages = Object.values(data?.query?.pages ?? {});
    const withImage = pages.find(p => p.thumbnail?.source);
    return withImage?.thumbnail?.source ?? null;
  } catch {
    return null;
  }
}

app.post('/api/suggest', async (req, res) => {
  const { recipient, budgetMin, budgetMax, previousSuggestions = [] } = req.body;

  if (!recipient || !budgetMin || !budgetMax) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const avoidList = previousSuggestions.length > 0
    ? `\n\nDo NOT suggest any of these already-shown items: ${previousSuggestions.join('; ')}.`
    : '';

  const prompt = `You are a thoughtful gift recommendation expert. Suggest ONE specific, real product available on Amazon as a gift.

Gift recipient: ${recipient}
Budget: $${budgetMin} to $${budgetMax}${avoidList}

Rules:
- The product must fit within the $${budgetMin}–$${budgetMax} budget.
- Be specific — name a real product type easily findable on Amazon.
- Tailor the recommendation to the recipient description.

Respond with ONLY a valid JSON object — no markdown, no code fences, no explanation:
{
  "name": "Specific product name",
  "description": "2–3 sentences on why this makes a wonderful gift for the recipient.",
  "price": "~$XX–$XX",
  "category": "Short category label (e.g. Books, Gadgets, Kitchen, Beauty, Outdoors)",
  "emoji": "Single relevant emoji",
  "searchTerms": "Best Amazon search query to find this product"
}`;

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 600,
    });

    const raw = response.choices[0].message.content.trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in response');

    const gift = JSON.parse(match[0]);
    gift.amazonUrl = `https://www.amazon.com/s?k=${encodeURIComponent(gift.searchTerms)}`;

    // Try Amazon first, fall back to Wikipedia
    gift.imageUrl = await fetchAmazonImage(gift.searchTerms)
      ?? await fetchWikipediaImage(gift.searchTerms);

    console.log(`Image for "${gift.name}":`, gift.imageUrl ?? 'none (will use emoji)');
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
