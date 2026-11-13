import 'dotenv/config';
import express, { type Request } from 'express';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { GoogleGenAI, ThinkingLevel, type Content, type Part } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const PRIMARY_MODEL = 'gemini-4-hydrogen';
const FALLBACK_MODEL = 'gemini-3.1-flash-lite';

interface IncomingMessage {
  role: string;
  text?: string;
  content?: string;
  image?: string | null;
}

interface ChatRequestBody {
  system?: string;
  messages?: IncomingMessage[];
  mode?: string;
}

function createGenAI(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in environment secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function buildSystemInstruction(clientSystem?: string, mode?: string): string {
  const corePersona = [
    'You are Akira, a warm, intelligent, and approachable AI companion and study assistant.',
    'You support BOTH academic studying AND open-ended, non-study conversations.',
    'Adapt naturally to the user’s intent:',
    '1. NON-STUDY / CASUAL CONVERSATIONS: If the user wants to talk about something other than studies — such as their day, feelings, stress, hobbies, movies, anime, music, games, sports, technology, creative ideas, life advice, humor, or casual banter — respond naturally like a thoughtful, engaging, down-to-earth companion. Do NOT force homework steps, quizzes, diagrams, or academic framing onto non-study chats.',
    '2. STUDY / LEARNING REQUESTS: When the user asks about schoolwork, concepts, homework, writing, study planning, or quizzes, follow the requested level, subject, mode, hint preference, and diagram instructions clearly and helpfully.',
    '3. SEAMLESS SWITCHING: If a user switches between casual conversation and studying at any point in the chat, follow their lead effortlessly without lecturing them to get back to studying.',
    'Keep responses clear, concise, respectful, and supportive. Respect the user’s preferred answer language.',
  ].join('\n');

  const modeNote =
    mode === 'Chat'
      ? '\nThe user explicitly selected Chat mode for open, natural conversation about anything on their mind.'
      : '';

  const extra = clientSystem?.trim() ? `\n\nContext & user preferences:\n${clientSystem.trim()}` : '';
  return `${corePersona}${modeNote}${extra}`;
}

function toGeminiContents(messages: IncomingMessage[]): Content[] {
  const contents: Content[] = [];

  for (const msg of messages) {
    if (!msg) continue;
    const rawText = String(msg.text ?? msg.content ?? '').trim();
    const parts: Part[] = [];

    if (msg.image && typeof msg.image === 'string') {
      const match = msg.image.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
      if (match) {
        parts.push({
          inlineData: {
            mimeType: match[1],
            data: match[2],
          },
        });
      }
    }

    if (rawText) {
      parts.push({ text: rawText });
    } else if (parts.length > 0) {
      parts.push({ text: 'Please look at this image and help me with it.' });
    }

    if (parts.length === 0) continue;

    contents.push({
      role: msg.role === 'model' || msg.role === 'assistant' ? 'model' : 'user',
      parts,
    });
  }

  return contents;
}

function parseErrorInfo(err: unknown): { status: number; message: string; fallbackable: boolean } {
  const raw = err instanceof Error ? err.message : String(err);
  if (/GEMINI_API_KEY is not configured/i.test(raw)) {
    return {
      status: 500,
      message: 'GEMINI_API_KEY is missing. Add it in Settings > Secrets.',
      fallbackable: false,
    };
  }
  if (/403|PERMISSION_DENIED|API_KEY_INVALID|API key not valid/i.test(raw)) {
    return {
      status: 403,
      message: 'Invalid or unauthorized Gemini API key. Check your key in Settings > Secrets.',
      fallbackable: false,
    };
  }
  if (/429|RESOURCE_EXHAUSTED|quota|rate/i.test(raw)) {
    return {
      status: 429,
      message: 'Akira is getting too many requests right now. Please wait a few seconds and try again.',
      fallbackable: true,
    };
  }
  if (/503|UNAVAILABLE|high demand|overloaded/i.test(raw)) {
    return {
      status: 503,
      message: 'Akira is experiencing high demand right now. Please try again in a few seconds.',
      fallbackable: true,
    };
  }
  return {
    status: 500,
    message: 'Could not reach Akira right now. Please try again in a moment.',
    fallbackable: /ECONNRESET|ETIMEDOUT|500|INTERNAL|404|NOT_FOUND/i.test(raw),
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function openGeminiStream(
  ai: GoogleGenAI,
  contents: Content[],
  systemInstruction: string
) {
  const attempts: Array<{
    model: string;
    thinkingLevel?: ThinkingLevel;
    timeoutMs: number;
    delayMs: number;
  }> = [
    { model: FALLBACK_MODEL, timeoutMs: 10000, delayMs: 0 },
    { model: FALLBACK_MODEL, timeoutMs: 12000, delayMs: 500 },
    { model: PRIMARY_MODEL, thinkingLevel: ThinkingLevel.LOW, timeoutMs: 12000, delayMs: 0 },
  ];

  let lastErr: unknown = null;
  for (let i = 0; i < attempts.length; i++) {
    const { model, thinkingLevel, timeoutMs, delayMs } = attempts[i];
    if (delayMs > 0) await wait(delayMs);
    const t0 = Date.now();
    try {
      const result = await withTimeout(
        (async () => {
          const stream = await ai.models.generateContentStream({
            model,
            contents,
            config: {
              systemInstruction,
              ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
            },
          });
          const iter = stream[Symbol.asyncIterator]();
          const first = await iter.next();
          return { first, iter };
        })(),
        timeoutMs,
        model
      );
      return result;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const info = parseErrorInfo(err);
      const isTimeout = /timed out/i.test(msg);
      console.warn(`[Akira] ${model} failed in ${Date.now() - t0}ms:`, msg);
      if ((!info.fallbackable && !isTimeout) || i === attempts.length - 1) {
        throw err;
      }
    }
  }
  throw lastErr;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function createZipBuffer(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const compressed = zlib.deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

let activeBuild: Promise<void> | null = null;
async function ensureDistBuilt(): Promise<string> {
  const distDir = path.resolve(__dirname, 'dist');
  const distHtml = path.join(distDir, 'index.html');
  if (process.env.NODE_ENV !== 'production' || !existsSync(distHtml)) {
    if (!activeBuild) {
      activeBuild = (async () => {
        const { build } = await import('vite');
        await build({ root: __dirname, logLevel: 'silent' });
      })().finally(() => {
        activeBuild = null;
      });
    }
    await activeBuild;
  }
  return distDir;
}

function getRequestOrigin(req: Request): string {
  const envUrl = process.env.APP_URL?.trim();
  if (envUrl && /^https?:\/\//i.test(envUrl)) {
    return envUrl.replace(/\/$/, '');
  }
  const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string)?.split(',')[0]?.trim() || req.get('host') || '';
  return host ? `${proto}://${host}` : '';
}

async function buildStandaloneHtml(apiOrigin: string): Promise<string> {
  const distDir = await ensureDistBuilt();
  let html = await fs.readFile(path.join(distDir, 'index.html'), 'utf8');

  const linkMatches = [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi)];
  for (const match of linkMatches) {
    const assetRel = match[1].replace(/^\//, '');
    const assetPath = path.join(distDir, assetRel);
    if (existsSync(assetPath)) {
      const css = await fs.readFile(assetPath, 'utf8');
      html = html.replace(match[0], `<style>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`);
    }
  }

  const scriptContents: string[] = [];
  const scriptMatches = [...html.matchAll(/<script\b[^>]*type=["']module["'][^>]*src=["']([^"']+)["'][^>]*><\/script>/gi)];
  for (const match of scriptMatches) {
    const assetRel = match[1].replace(/^\//, '');
    const assetPath = path.join(distDir, assetRel);
    if (existsSync(assetPath)) {
      const js = await fs.readFile(assetPath, 'utf8');
      scriptContents.push(js.replace(/<\/(script)/gi, '<\\/$1'));
      html = html.replace(match[0], '');
    }
  }

  const apiBootstrap = apiOrigin
    ? `<script>window.__AKIRA_API_BASE__ = ${JSON.stringify(apiOrigin)};</script>`
    : '';
  const bundledScripts = scriptContents.map((js) => `<script type="module">\n${js}\n</script>`).join('\n');

  return html.replace('</body>', `${apiBootstrap}\n${bundledScripts}\n</body>`);
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  app.options('/api/chat', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
  });

  app.get('/download', async (req, res) => {
    try {
      const html = await buildStandaloneHtml(getRequestOrigin(req));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="akira-ai.html"');
      res.setHeader('Cache-Control', 'no-store');
      res.send(html);
    } catch (err) {
      console.error('Failed to build downloadable HTML:', err);
      res.status(500).send('Could not prepare the downloadable file.');
    }
  });

  app.get('/download/zip', async (_req, res) => {
    try {
      const relFiles = [
        '.env.example',
        'index.html',
        'metadata.json',
        'netlify.toml',
        'netlify/functions/chat.mts',
        'package.json',
        'server.ts',
        'tsconfig.json',
        'vite.config.ts',
        'src/akira.ts',
        'src/index.css',
        'src/main.tsx',
      ];
      const entries: Array<{ name: string; data: Buffer }> = [];
      for (const rel of relFiles) {
        const full = path.join(__dirname, rel);
        if (existsSync(full)) {
          entries.push({ name: `akira-ai/${rel}`, data: await fs.readFile(full) });
        }
      }
      const zipBuf = createZipBuffer(entries);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="akira-ai-source.zip"');
      res.setHeader('Cache-Control', 'no-store');
      res.send(zipBuf);
    } catch (err) {
      console.error('Failed to build source ZIP:', err);
      res.status(500).send('Could not prepare the ZIP download.');
    }
  });

  app.post('/api/chat', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const body = (req.body || {}) as ChatRequestBody;
    const incoming = Array.isArray(body.messages) ? body.messages : [];
    const contents = toGeminiContents(incoming);

    if (contents.length === 0) {
      res.status(400).json({ error: 'Please enter a message or attach an image.' });
      return;
    }

    let aborted = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        aborted = true;
      }
    });

    try {
      const ai = createGenAI();
      const systemInstruction = buildSystemInstruction(body.system, body.mode);
      const { first, iter } = await openGeminiStream(ai, contents, systemInstruction);

      if (aborted) return;

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      let sentAny = false;
      if (!first.done && first.value?.text) {
        sentAny = true;
        res.write(first.value.text);
      }

      if (!first.done) {
        while (true) {
          if (aborted || res.writableEnded) break;
          const next = await iter.next();
          if (next.done) break;
          const text = next.value?.text;
          if (text) {
            sentAny = true;
            res.write(text);
          }
        }
      }

      if (!aborted && !res.writableEnded) {
        if (!sentAny) {
          res.write("I'm here! Could you say that again or tell me a bit more?");
        }
        res.end();
      }
    } catch (err) {
      console.error('Gemini /api/chat error:', err);
      const { status, message } = parseErrorInfo(err);
      if (!res.headersSent) {
        res.status(status).json({ error: message });
      } else if (!aborted && !res.writableEnded) {
        res.end(`\n\n${message}`);
      }
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Akira AI server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
