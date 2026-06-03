const express = require('express');
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'links.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Upstash REST API — sends a single Redis command as a JSON array
async function upstash(...command) {
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Upstash: ${data.error}`);
  return data.result;
}

// File helpers (local dev fallback)
function fileRead() {
  if (!fs.existsSync(DATA_FILE)) return {};
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function fileWrite(links) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(links, null, 2));
}

// Per-link CRUD (each link = its own Redis key "link:{code}")
async function getLink(code) {
  if (process.env.UPSTASH_REDIS_REST_URL) {
    const result = await upstash('GET', `link:${code}`);
    return result ? JSON.parse(result) : null;
  }
  return fileRead()[code] || null;
}

async function setLink(code, data) {
  if (process.env.UPSTASH_REDIS_REST_URL) {
    await upstash('SET', `link:${code}`, JSON.stringify(data));
    return;
  }
  const links = fileRead();
  links[code] = data;
  fileWrite(links);
}

async function removeLink(code) {
  if (process.env.UPSTASH_REDIS_REST_URL) {
    await upstash('DEL', `link:${code}`);
    return;
  }
  const links = fileRead();
  delete links[code];
  fileWrite(links);
}

async function getAllLinks() {
  if (process.env.UPSTASH_REDIS_REST_URL) {
    const [, keys] = await upstash('SCAN', '0', 'MATCH', 'link:*', 'COUNT', '100');
    if (!keys || keys.length === 0) return [];
    const values = await upstash('MGET', ...keys);
    return keys
      .map((key, i) => values[i] ? { code: key.replace('link:', ''), ...JSON.parse(values[i]) } : null)
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  return Object.entries(fileRead())
    .map(([code, data]) => ({ code, ...data }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// POST /api/links — create short link
app.post('/api/links', async (req, res) => {
  const { url, alias } = req.body;
  if (!url || !url.startsWith('http'))
    return res.status(400).json({ error: 'URL tidak valid. Harus diawali dengan http:// atau https://' });

  const code = alias ? alias.trim() : nanoid(6);
  if (!/^[a-zA-Z0-9_-]+$/.test(code))
    return res.status(400).json({ error: 'Alias hanya boleh mengandung huruf, angka, - dan _' });
  if (code.length > 30)
    return res.status(400).json({ error: 'Alias maksimal 30 karakter' });

  if (await getLink(code))
    return res.status(409).json({ error: `Alias "${code}" sudah digunakan` });

  await setLink(code, { url, clicks: 0, createdAt: new Date().toISOString() });
  res.json({ code, url, shortUrl: `${req.protocol}://${req.get('host')}/${code}` });
});

// GET /api/links — list all links
app.get('/api/links', async (req, res) => {
  res.json(await getAllLinks());
});

// DELETE /api/links/:code — delete a link
app.delete('/api/links/:code', async (req, res) => {
  const { code } = req.params;
  if (!await getLink(code)) return res.status(404).json({ error: 'Link tidak ditemukan' });
  await removeLink(code);
  res.json({ success: true });
});

// GET /:code — redirect
app.get('/:code', async (req, res) => {
  const { code } = req.params;
  const link = await getLink(code);
  if (!link) return res.status(404).send('Link tidak ditemukan');
  await setLink(code, { ...link, clicks: link.clicks + 1 });
  res.redirect(link.url);
});

app.listen(PORT, () => console.log(`Server berjalan di http://localhost:${PORT}`));
module.exports = app;
