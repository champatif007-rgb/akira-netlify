import { GoogleGenAI, ThinkingLevel, type Content, type Part } from '@google/genai';

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
      message: 'GEMINI_API_KEY is missing. Add it in Netlify Environment variables.',
      fallbackable: false,
    };
  }
  if (/403|PERMISSION_DENIED|API_KEY_INVALID|API key not valid/i.test(raw)) {
    return {
      status: 403,
      message: 'Invalid or unauthorized Gemini API key. Check your key in Environment variables.',
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

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'GEMINI_API_KEY is not configured in environment variables.' },
      { status: 500 }
    );
  }

  let body: ChatRequestBody = {};
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const incoming = Array.isArray(body.messages) ? body.messages : [];
  const contents = toGeminiContents(incoming);
  if (contents.length === 0) {
    return Response.json({ error: 'Please enter a message or attach an image.' }, { status: 400 });
  }

  const ai = new GoogleGenAI({ apiKey });
  const systemInstruction = buildSystemInstruction(body.system, body.mode);
  const attempts: Array<{ model: string; thinkingLevel?: ThinkingLevel }> = [
    { model: FALLBACK_MODEL },
    { model: PRIMARY_MODEL, thinkingLevel: ThinkingLevel.LOW },
  ];

  for (let i = 0; i < attempts.length; i++) {
    const { model, thinkingLevel } = attempts[i];
    try {
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

      const encoder = new TextEncoder();
      const readable = new ReadableStream<Uint8Array>({
        async start(controller) {
          let sentAny = false;
          try {
            if (!first.done && first.value?.text) {
              sentAny = true;
              controller.enqueue(encoder.encode(first.value.text));
            }
            if (!first.done) {
              while (true) {
                const next = await iter.next();
                if (next.done) break;
                const text = next.value?.text;
                if (text) {
                  sentAny = true;
                  controller.enqueue(encoder.encode(text));
                }
              }
            }
            if (!sentAny) {
              controller.enqueue(encoder.encode("I'm here! Could you say that again or tell me a bit more?"));
            }
          } catch (err) {
            const { message } = parseErrorInfo(err);
            controller.enqueue(encoder.encode(`\n\n${message}`));
          } finally {
            controller.close();
          }
        },
      });

      return new Response(readable, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (err) {
      const info = parseErrorInfo(err);
      if (!info.fallbackable || i === attempts.length - 1) {
        return Response.json(
          { error: info.message },
          { status: info.status, headers: { 'Access-Control-Allow-Origin': '*' } }
        );
      }
    }
  }

  return Response.json({ error: 'Could not reach Akira right now. Please try again.' }, { status: 500 });
}
