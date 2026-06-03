const express = require('express');
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'links.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function loadLinks() {
  if (!fs.existsSync(DATA_FILE)) return {};
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveLinks(links) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(links, null, 2));
}

// POST /api/links — create short link
app.post('/api/links', (req, res) => {
  const { url, alias } = req.body;

  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'URL tidak valid. Harus diawali dengan http:// atau https://' });
  }

  const links = loadLinks();
  const code = alias ? alias.trim() : nanoid(6);

  if (!/^[a-zA-Z0-9_-]+$/.test(code)) {
    return res.status(400).json({ error: 'Alias hanya boleh mengandung huruf, angka, - dan _' });
  }

  if (code.length > 30) {
    return res.status(400).json({ error: 'Alias maksimal 30 karakter' });
  }

  if (links[code]) {
    return res.status(409).json({ error: `Alias "${code}" sudah digunakan` });
  }

  links[code] = { url, clicks: 0, createdAt: new Date().toISOString() };
  saveLinks(links);

  res.json({ code, url, shortUrl: `${req.protocol}://${req.get('host')}/${code}` });
});

// GET /api/links — list all links
app.get('/api/links', (req, res) => {
  const links = loadLinks();
  const list = Object.entries(links).map(([code, data]) => ({
    code,
    ...data,
  }));
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

// DELETE /api/links/:code — delete a link
app.delete('/api/links/:code', (req, res) => {
  const links = loadLinks();
  const { code } = req.params;
  if (!links[code]) return res.status(404).json({ error: 'Link tidak ditemukan' });
  delete links[code];
  saveLinks(links);
  res.json({ success: true });
});

// GET /:code — redirect
app.get('/:code', (req, res) => {
  const links = loadLinks();
  const { code } = req.params;
  if (!links[code]) return res.status(404).send('Link tidak ditemukan');
  links[code].clicks++;
  saveLinks(links);
  res.redirect(links[code].url);
});

app.listen(PORT, () => {
  console.log(`Server berjalan di http://localhost:${PORT}`);
});
