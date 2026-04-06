/**
 * Serves static files from repo root + POST /api/avatar-chat (RAG + OpenAI).
 * ESM (package.json "type": "module"). Run: npm install && npm start
 * Requires .env with OPENAI_API_KEY (see .env.example)
 */
import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import fs from 'fs';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o';
const EMBED_MODEL = 'text-embedding-3-small';
const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_KNOWLEDGE_DIR = path.join(REPO_ROOT, 'knowledge');

/**
 * @returns {string[]} Absolute directory paths to scan for .md
 */
function getKnowledgeRoots() {
    const multi = (process.env.KNOWLEDGE_DIRS || '').trim();
    if (multi) {
        return multi
            .split(',')
            .map((s) => path.resolve(s.trim()))
            .filter((p) => {
                if (!p) return false;
                if (!fs.existsSync(p)) {
                    console.warn(`[avatar] KNOWLEDGE_DIRS path missing, skip: ${p}`);
                    return false;
                }
                if (!fs.statSync(p).isDirectory()) {
                    console.warn(`[avatar] KNOWLEDGE_DIRS not a directory, skip: ${p}`);
                    return false;
                }
                return true;
            });
    }
    const single = (process.env.KNOWLEDGE_DIR || '').trim();
    if (single) {
        const p = path.resolve(single);
        if (!fs.existsSync(p)) {
            console.warn(`[avatar] KNOWLEDGE_DIR not found: ${p}`);
            return [];
        }
        if (!fs.statSync(p).isDirectory()) {
            console.warn(`[avatar] KNOWLEDGE_DIR is not a directory: ${p}`);
            return [];
        }
        return [p];
    }
    if (!fs.existsSync(DEFAULT_KNOWLEDGE_DIR)) {
        console.warn('[avatar] Default knowledge/ folder missing.');
        return [];
    }
    return [DEFAULT_KNOWLEDGE_DIR];
}

/** @type {string[]} */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

if (!process.env.OPENAI_API_KEY) {
    console.error('[avatar] Missing OPENAI_API_KEY. Copy .env.example to .env and add your key.');
    process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** @type {{ text: string, source: string, embedding: number[] }[]} */
let chunkStore = [];

function splitIntoChunks(text, maxLen) {
    const parts = text.split(/\n\n+/);
    const out = [];
    let buf = '';
    for (const p of parts) {
        const next = buf ? `${buf}\n\n${p}` : p;
        if (next.length > maxLen && buf) {
            out.push(buf.trim());
            buf = p;
        } else {
            buf = next;
        }
    }
    if (buf.trim()) out.push(buf.trim());
    return out.filter(Boolean);
}

function cosine(a, b) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d === 0 ? 0 : dot / d;
}

async function loadKnowledgeFiles() {
    chunkStore = [];
    const roots = getKnowledgeRoots();
    if (roots.length === 0) {
        console.warn('[avatar] No knowledge directories; RAG context will be empty.');
        return;
    }

    let totalMd = 0;

    for (const root of roots) {
        const rootTag = path.basename(root);
        const entries = fs.readdirSync(root);
        const mdFiles = entries.filter((f) => f.endsWith('.md'));
        totalMd += mdFiles.length;

        const src = (name) => (roots.length > 1 || root !== DEFAULT_KNOWLEDGE_DIR ? `${rootTag}/${name}` : name);

        for (const file of mdFiles) {
            const raw = fs.readFileSync(path.join(root, file), 'utf8');
            const chunks = splitIntoChunks(raw, 900);
            for (const text of chunks) {
                chunkStore.push({ text, source: src(file), embedding: [] });
            }
        }
    }

    console.log(`[avatar] Loaded ${chunkStore.length} chunks from ${roots.length} dir(s) (${totalMd} .md files).`);
}

async function embedChunkStore() {
    if (chunkStore.length === 0) return;
    const inputs = chunkStore.map((c) => c.text.slice(0, 8000));
    const batchSize = 64;
    for (let i = 0; i < inputs.length; i += batchSize) {
        const slice = inputs.slice(i, i + batchSize);
        const res = await openai.embeddings.create({
            model: EMBED_MODEL,
            input: slice
        });
        const ordered = res.data.slice().sort((a, b) => a.index - b.index);
        for (let j = 0; j < ordered.length; j++) {
            chunkStore[i + j].embedding = ordered[j].embedding;
        }
    }
    console.log('[avatar] Embeddings ready.');
}

function retrieve(queryEmbedding, k) {
    const scored = chunkStore
        .filter((c) => c.embedding.length)
        .map((c, idx) => ({ idx, score: cosine(queryEmbedding, c.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    return scored.map((s) => chunkStore[s.idx]);
}

const rateMap = new Map();
function allowRequest(ip) {
    const now = Date.now();
    const w = rateMap.get(ip) || { n: 0, t: now };
    if (now - w.t > 60_000) {
        w.n = 0;
        w.t = now;
    }
    w.n += 1;
    rateMap.set(ip, w);
    return w.n <= 40;
}

function clientIp(req) {
    const x = req.headers['x-forwarded-for'];
    if (typeof x === 'string' && x.length) return x.split(',')[0].trim();
    return req.socket.remoteAddress || 'local';
}

const SYSTEM_PERSONA = `You are the digital avatar of LIJIAYANG (an AI Product Manager). You answer visitors' questions in a professional, concise, friendly tone.

Rules:
- Ground answers in the "Knowledge excerpts" below when they are relevant. If something is not in the excerpts, say you do not have that detail in the published materials and suggest scrolling the site or using public contact methods if listed.
- Do not invent employers, dates, metrics, or private data.
- Match the visitor's language: use English if locale is "en", Simplified Chinese if locale is "zh".
- No markdown code fences unless the user asks for code; plain text or light line breaks are fine.
- Keep answers focused; prefer bullet lists for long lists.`;

const app = express();
if (process.env.TRUST_PROXY === '1') {
    app.set('trust proxy', 1);
}

app.use(express.json({ limit: '120kb' }));

function applyAvatarCors(req, res) {
    if (ALLOWED_ORIGINS.length === 0) return;
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Vary', 'Origin');
    }
}

app.options('/api/avatar-chat', (req, res) => {
    applyAvatarCors(req, res);
    res.status(204).end();
});

app.post('/api/avatar-chat', (req, res, next) => {
    applyAvatarCors(req, res);
    next();
}, async (req, res) => {
    const ip = clientIp(req);
    if (!allowRequest(ip)) {
        return res.status(429).json({ error: 'rate_limited' });
    }

    try {
        const { messages, locale } = req.body || {};
        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: 'messages_required' });
        }

        const safeLocale = locale === 'zh' ? 'zh' : 'en';
        const trimmed = messages
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }))
            .slice(-16);

        if (!trimmed.some((m) => m.role === 'user')) {
            return res.status(400).json({ error: 'user_message_required' });
        }

        const lastUser = [...trimmed].reverse().find((m) => m.role === 'user');
        const qEmb = await openai.embeddings.create({
            model: EMBED_MODEL,
            input: lastUser.content.slice(0, 8000)
        });
        const q = qEmb.data[0].embedding;

        const top = retrieve(q, 6);
        const kb =
            top.length === 0
                ? '(No knowledge excerpts matched this query; rely on general AI PM guidance and say when facts are unknown.)'
                : top
                      .map((c, i) => `[${i + 1}] (source: ${c.source})\n${c.text}`)
                      .join('\n\n---\n\n');

        const systemContent = `${SYSTEM_PERSONA}\n\nlocale: ${safeLocale}\n\nKnowledge excerpts:\n${kb}`;

        const completion = await openai.chat.completions.create({
            model: MODEL,
            messages: [{ role: 'system', content: systemContent }, ...trimmed],
            max_tokens: 1400,
            temperature: 0.45
        });

        const reply = completion.choices[0]?.message?.content?.trim() || '';
        return res.json({ reply });
    } catch (err) {
        console.error('[avatar] chat error:', err.message || err);
        return res.status(500).json({ error: 'upstream_failed' });
    }
});

app.use(express.static(REPO_ROOT));

async function main() {
    await loadKnowledgeFiles();
    await embedChunkStore();
    app.listen(PORT, () => {
        console.log(`[site] http://localhost:${PORT}/index.html`);
        console.log(`[avatar] POST http://localhost:${PORT}/api/avatar-chat`);
        console.log(`[avatar] Model: ${MODEL}`);
        if (ALLOWED_ORIGINS.length) {
            console.log(`[avatar] CORS allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
        }
    });
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
