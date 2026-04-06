import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

/** 启动/冷启动时读一次 knowledge/*.md，缓存在内存（更新知识库需重新部署） */
let knowledgeMarkdownCache = null;

function loadKnowledgeMarkdown() {
    if (knowledgeMarkdownCache !== null) {
        return knowledgeMarkdownCache;
    }
    try {
        const dir = path.join(process.cwd(), 'knowledge');
        if (!fs.existsSync(dir)) {
            console.warn('api/chat: knowledge dir missing at', dir);
            knowledgeMarkdownCache = '';
            return knowledgeMarkdownCache;
        }
        const names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
        const chunks = [];
        for (const name of names) {
            const full = path.join(dir, name);
            const text = fs.readFileSync(full, 'utf8');
            chunks.push(`### ${name}\n\n${text.trim()}`);
        }
        knowledgeMarkdownCache = chunks.join('\n\n---\n\n');
    } catch (e) {
        console.error('api/chat: failed to load knowledge', e);
        knowledgeMarkdownCache = '';
    }
    return knowledgeMarkdownCache;
}

function buildSystemPrompt() {
    const knowledge = loadKnowledgeMarkdown();
    const base =
        '你是李佳阳（LIJIAYANG）个人网站上的数字分身助手。回答要专业、清晰、简洁，与用户使用的语言一致（中文问题用中文答）。\n\n' +
        '【必须遵守】在回答任何关于李佳阳的经历、项目、技能、联系方式或网站结构的问题前，必须先依据下方「知识库」中的内容；优先引用知识库中的事实与表述。\n' +
        '若知识库中没有相关信息，明确说「资料里没有写到」或「当前知识库未覆盖」，不要猜测或编造经历、数据、公司细节、邮箱电话等；知识库已写明的联系方式可以如实复述。\n' +
        '若问题与李佳阳及其工作无关，可礼貌说明你是本站数字分身，只讨论与他相关的话题。';

    if (!knowledge) {
        return `${base}\n\n（当前未加载到知识库文件；仅可按通用设定简要回答，并说明知识库未挂载。）`;
    }
    return `${base}\n\n---\n\n## 知识库（唯一可信来源）\n\n${knowledge}`;
}

/**
 * 浏览器跨域：必须先 204 响应 OPTIONS，且 POST 响应也要带 CORS 头。
 * 未部署这段时，curl POST 仍可能 200，但浏览器会因预检 405 而拿不到 body（表现为「前端不回」）。
 */
function setCors(req, res) {
    const fixed = process.env.ALLOWED_ORIGIN;
    if (fixed) {
        res.setHeader('Access-Control-Allow-Origin', fixed);
    } else {
        const origin = req.headers.origin;
        if (origin) {
            res.setHeader('Access-Control-Allow-Origin', origin);
        } else {
            res.setHeader('Access-Control-Allow-Origin', '*');
        }
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(req, res) {
    setCors(req, res);

    // 部分运行环境（含部分 Vercel 版本）里 method 可能非严格大写；预检失败时浏览器会直接报网络错误。
    const method = String(req.method || '').toUpperCase();

    if (method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { message, messages } = req.body || {};

        const history = Array.isArray(messages) ? messages : [];
        const latestMessage = message || '';

        if (!latestMessage && history.length === 0) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const inputMessages = [
            {
                role: 'system',
                content: buildSystemPrompt()
            },
            ...history,
            ...(latestMessage ? [{ role: 'user', content: latestMessage }] : [])
        ];

        const response = await client.responses.create({
            model: 'gpt-5.4-mini',
            input: inputMessages
        });

        return res.status(200).json({
            reply: response.output_text
        });
    } catch (error) {
        console.error('OpenAI error:', error);
        return res.status(500).json({ error: 'Server error' });
    }
}
