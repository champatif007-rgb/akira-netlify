interface ChatMessage {
  r: 'user' | 'model';
  t: string;
  img?: string | null;
  think?: boolean;
  stopped?: boolean;
}

interface ChatSession {
  title: string;
  msgs: ChatMessage[];
}

interface NoteItem {
  t: string;
  d: string;
  s: string;
}

interface StudyDay {
  q: number;
  f: number;
}

interface StudyStats {
  days?: Record<string, StudyDay>;
  goal?: number;
  exam?: string;
}

interface FormatSettings {
  fs: number;
  lh: string;
  ff: string;
  layout: string;
  fx: string;
  cur: string;
}

interface WindowWithVoice extends Window {
  SpeechRecognition?: new () => SpeechRecognitionInstance;
  webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
  curApply?: () => void;
  __AKIRA_API_BASE__?: string;
}

interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((e: { results: { [index: number]: { [index: number]: { transcript: string } } } }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

export function initAkira(): void {
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
    document.getElementById(id) as T;
  const L = localStorage;
  const win = window as WindowWithVoice;

  const MODES: Record<string, [string, string]> = {
    Homework: ['📝', 'Solve step by step and explain why each step works.'],
    Explain: ['💡', 'Explain the concept simply with an analogy and an example.'],
    Quiz: ['❓', 'Quiz me: ask 5 questions one at a time, wait for my answer, then give feedback.'],
    Writing: ['✍️', 'Help with writing: improve, outline or draft, and say what you changed.'],
    Planner: ['📅', 'Make a realistic study plan with times and short breaks.'],
    Draw: ['🎨', 'Draw the idea as a clean inline SVG diagram inside a ```svg code block, plus a short caption.'],
    Chat: [
      '💬',
      'Have a natural, friendly, open-ended conversation about anything — daily life, hobbies, movies, games, feelings, creativity, or random thoughts — without forcing a study or homework structure.',
    ],
  };

  const SUBS: [string, string][] = [
    ['Math', '➗'],
    ['Science', '🧪'],
    ['English', '📖'],
    ['Hindi', '🪔'],
    ['Social science', '🌍'],
    ['Computer science', '💻'],
    ['Off-topic / Casual', '💬'],
  ];

  let mode = 'Homework';
  let hint = false;
  let pics = true;
  let img: string | null = null;
  let chats: ChatSession[] = [];
  try {
    chats = JSON.parse(L.akChats || '[]');
  } catch {
    chats = [];
  }
  let cur: ChatSession | null = null;
  let theme = L.akTheme || 'dark';
  let gen = false;
  let activeAbort: AbortController | null = null;

  document.documentElement.dataset.theme = theme;
  const save = () => {
    L.akChats = JSON.stringify(chats.slice(0, 40));
  };

  let toastTimer: number | undefined;
  function toast(t: string) {
    const e = $('toast');
    e.textContent = t;
    e.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => e.classList.remove('on'), 2200);
  }

  /* ===== AI via /api/chat (streaming server-side Gemini) ===== */
  async function callAI(params: {
    system: string;
    messages: { role: string; content: string; img?: string | null }[];
    image?: string | null;
    mode?: string;
    signal?: AbortSignal;
    onChunk?: (fullTextSoFar: string) => void;
  }): Promise<string> {
    const hist = (params.messages || [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content != null)
      .slice(-16);

    const payload = {
      system: params.system || '',
      mode: params.mode || mode,
      messages: hist.map((m, i) => {
        const o: { role: string; text: string; image?: string } = {
          role: m.role === 'assistant' ? 'model' : 'user',
          text: String(m.content),
        };
        const attached = i === hist.length - 1 ? params.image || m.img : m.img;
        if (attached && m.role === 'user') o.image = attached;
        return o;
      }),
    };

    const apiBase = (win.__AKIRA_API_BASE__ || '').replace(/\/$/, '');
    const chatUrl = apiBase ? `${apiBase}/api/chat` : '/api/chat';

    const res = await fetch(chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: params.signal,
    });

    if (res.status === 429) {
      throw new Error('Akira is busy right now. Please wait a minute and try again.');
    }
    if (res.status === 413) {
      throw new Error('That photo is too large. Please try a smaller one.');
    }
    if (!res.ok) {
      let msg = '';
      try {
        const j = await res.json();
        msg = j.error || j.message || '';
      } catch {
        // ignore JSON parse error
      }
      throw new Error(msg || `Something went wrong (${res.status}). Please try again.`);
    }

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await res.json();
      const text = String(data.text || data.reply || data.message || '').trim();
      if (!text) throw new Error('Empty reply. Please try again.');
      params.onChunk?.(text);
      return text;
    }

    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        if (text.trim()) params.onChunk?.(text);
      }
      text += dec.decode();
      text = text.trim();
      if (!text) throw new Error('Empty reply. Please try again.');
      return text;
    }

    const text = (await res.text()).trim();
    if (!text) throw new Error('Empty reply. Please try again.');
    params.onChunk?.(text);
    return text;
  }

  /* palettes */
  const PAL: Record<string, Record<string, string>> = {
    nebula: {
      bg: '#050819',
      acc: '#4f7bff',
      acc2: '#9a5cff',
      cy: '#52f0ff',
      pk: '#ff7ad9',
      g1: '#2a47d8',
      g2: '#8a3cff',
      g3: '#12b7d8',
      pn1: '#19205a',
      pn2: '#080b28',
    },
    sunset: {
      bg: '#14060d',
      acc: '#ff6b3d',
      acc2: '#ff3d8b',
      cy: '#ffd166',
      pk: '#ff9ad5',
      g1: '#c2410c',
      g2: '#be185d',
      g3: '#f59e0b',
      pn1: '#4a1620',
      pn2: '#1a0710',
    },
    emerald: {
      bg: '#03120d',
      acc: '#10b981',
      acc2: '#06b6d4',
      cy: '#7dffc2',
      pk: '#a3e635',
      g1: '#047857',
      g2: '#0e7490',
      g3: '#65a30d',
      pn1: '#0c3d2e',
      pn2: '#04150f',
    },
    crimson: {
      bg: '#12040a',
      acc: '#ef4444',
      acc2: '#a855f7',
      cy: '#ff8fa3',
      pk: '#fb7185',
      g1: '#b91c1c',
      g2: '#7e22ce',
      g3: '#e11d48',
      pn1: '#45101c',
      pn2: '#17050b',
    },
    aqua: {
      bg: '#041018',
      acc: '#0ea5e9',
      acc2: '#3b82f6',
      cy: '#67e8f9',
      pk: '#a5b4fc',
      g1: '#0369a1',
      g2: '#1d4ed8',
      g3: '#06b6d4',
      pn1: '#0b3350',
      pn2: '#050f1a',
    },
  };

  function setPal(n: string) {
    const c = PAL[n] || PAL.nebula;
    for (const k in c) document.documentElement.style.setProperty('--' + k, c[k]);
    L.akPal = n;
    document.querySelectorAll<HTMLElement>('#sw i').forEach((i) => i.classList.toggle('on', i.dataset.p === n));
  }

  $('sw').innerHTML = Object.entries(PAL)
    .map(
      ([n, c]) =>
        `<i data-p="${n}" title="${n}" style="background:linear-gradient(135deg,${c.acc},${c.acc2});color:${c.acc}"></i>`
    )
    .join('');
  $('sw').onclick = (e) => {
    const i = (e.target as HTMLElement).closest('i');
    if (i && i.dataset.p) {
      setPal(i.dataset.p);
      toast('Colours: ' + i.dataset.p);
    }
  };
  setPal(L.akPal || 'nebula');

  /* ripple */
  document.addEventListener('pointerdown', (e) => {
    const b = (e.target as HTMLElement).closest('.btn,.pill,.go');
    if (!b) return;
    const r = b.getBoundingClientRect();
    const s = document.createElement('span');
    s.className = 'rip';
    const d = Math.max(r.width, r.height);
    s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
    b.appendChild(s);
    setTimeout(() => s.remove(), 600);
  });

  /* starfield */
  const cv = $<HTMLCanvasElement>('sky');
  const cx = cv.getContext('2d')!;
  let W = 0;
  let H = 0;
  let stars: { x: number; y: number; z: number; p: number }[] = [];
  let mx = 0;
  let my = 0;
  let shoot: { x: number; y: number; l: number } | null = null;

  function rs() {
    W = cv.width = innerWidth;
    H = cv.height = innerHeight;
    stars = Array.from({ length: Math.min(170, (W / 6) | 0) }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      z: Math.random() * 0.9 + 0.1,
      p: Math.random() * 6,
    }));
  }
  rs();
  addEventListener('resize', rs);
  addEventListener('pointermove', (e) => {
    mx = e.clientX / W - 0.5;
    my = e.clientY / H - 0.5;
  });

  (function tick(t: number) {
    cx.clearRect(0, 0, W, H);
    if (theme === 'dark') {
      stars.forEach((s) => {
        const a = 0.35 + 0.65 * Math.abs(Math.sin((t / 900) * s.z + s.p));
        cx.globalAlpha = a;
        cx.fillStyle = '#fff';
        cx.beginPath();
        cx.arc(s.x - mx * 30 * s.z, s.y - my * 30 * s.z, s.z * 1.6, 0, 7);
        cx.fill();
      });
      if (!shoot && Math.random() < 0.004) {
        shoot = { x: Math.random() * W * 0.7, y: Math.random() * H * 0.4, l: 0 };
      }
      if (shoot) {
        const g = cx.createLinearGradient(shoot.x, shoot.y, shoot.x - 90, shoot.y - 45);
        g.addColorStop(0, '#fff');
        g.addColorStop(1, 'transparent');
        cx.globalAlpha = 1;
        cx.strokeStyle = g;
        cx.lineWidth = 2;
        cx.beginPath();
        cx.moveTo(shoot.x, shoot.y);
        cx.lineTo(shoot.x - 90, shoot.y - 45);
        cx.stroke();
        shoot.x += 14;
        shoot.y += 7;
        if (++shoot.l > 70) shoot = null;
      }
    }
    requestAnimationFrame(tick);
  })(0);

  /* modes with tilt */
  $('modes').innerHTML = Object.entries(MODES)
    .map(
      ([k, v], i) =>
        `<button class="mode${k === mode ? ' on' : ''}" data-m="${k}" style="animation-delay:${i * 0.07}s"><b>${v[0]}</b>${k}</button>`
    )
    .join('');

  $('modes').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.mode');
    if (!b || !b.dataset.m) return;
    mode = b.dataset.m;
    document.querySelectorAll('.mode').forEach((x) => x.classList.toggle('on', x === b));
    toast(mode === 'Chat' ? 'Chat mode — talk about anything!' : mode + ' mode');
  };

  $('modes').onpointermove = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.mode');
    if (!b) return;
    const r = b.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    b.style.setProperty('--ry', (x - 0.5) * 26 + 'deg');
    b.style.setProperty('--rx', (0.5 - y) * 26 + 'deg');
    b.style.setProperty('--mx', x * 100 + '%');
    b.style.setProperty('--my', y * 100 + '%');
  };

  $('modes').onpointerleave = () =>
    document.querySelectorAll<HTMLElement>('.mode').forEach((b) => {
      b.style.setProperty('--rx', '0deg');
      b.style.setProperty('--ry', '0deg');
    });

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

  function md(t: string): string {
    const svgs: string[] = [];
    t = t.replace(/```svg\n([\s\S]*?)```/g, (_, s: string) => {
      svgs.push(s.replace(/<script[\s\S]*?<\/script>|\son\w+="[^"]*"/gi, ''));
      return '@@S' + (svgs.length - 1) + '@@';
    });
    const codes: string[] = [];
    t = t.replace(/```\w*\n?([\s\S]*?)(```|$)/g, (_, c: string) => {
      codes.push(c);
      return '@@C' + (codes.length - 1) + '@@';
    });
    t = esc(t)
      .replace(/^\|(.+)\|\s*$/gm, (l) =>
        /^[\s|:-]+$/.test(l)
          ? ''
          : '<tr>' +
            l
              .slice(1, -1)
              .split('|')
              .map((c) => `<td>${c.trim()}</td>`)
              .join('') +
            '</tr>'
      )
      .replace(/(<tr>[\s\S]*?<\/tr>\n?)+/g, (m) => `<table>${m}</table>`)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^#+\s*(.+)$/gm, '<b>$1</b>');
    return t
      .replace(/@@S(\d+)@@/g, (_, i) => svgs[Number(i)])
      .replace(/@@C(\d+)@@/g, (_, i) => `<pre>${esc(codes[Number(i)])}</pre>`);
  }

  const body = (m: ChatMessage) =>
    m.think
      ? `<div class="dots"><span class="akira-loader"><i></i></span><span class="loader-copy">Akira is thinking</span></div>`
      : m.r === 'user'
        ? esc(m.t)
        : md(m.t);

  const IC = (d: string) => `<svg viewBox="0 0 24 24">${d}</svg>`;
  const greet = () => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  };
  const act = (last: boolean) =>
    `<div class="act"><button data-a="copy" title="Copy">${IC('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>')}</button><button data-a="note" title="Save to notes">${IC('<path d="M6 3h12v18l-6-4-6 4z"/>')}</button><button data-a="share" title="Share">${IC('<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 11l7.6-4.5M8.2 13l7.6 4.5"/>')}</button><button data-a="say" title="Read aloud">${IC('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>')}</button>${last ? `<button data-a="redo" title="Answer again">${IC('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>')}</button>` : ''}</div>`;

  const subjectSelect = () => $<HTMLSelectElement>('subject');
  const levelSelect = () => $<HTMLSelectElement>('level');
  const langSelect = () => $<HTMLSelectElement>('lang');

  function draw() {
    const f = $('feed');
    if (!cur || !cur.msgs.length) {
      f.innerHTML = `<div class="hero"><div class="big"><div class="orb"><b></b><u></u></div></div><h1>Welcome to Akira AI<br>Your all-in-one study &amp; chat companion</h1><p>${greet()}! Pick a subject to study, or just talk about anything below.</p><div class="subs">${SUBS.map((s, i) => `<button class="sub${subjectSelect().value === s[0] ? ' on' : ''}" data-s="${s[0]}" style="animation-delay:${0.3 + i * 0.08}s"><b>${s[1]}</b>${s[0]}</button>`).join('')}</div></div>`;
    } else {
      f.innerHTML = cur.msgs
        .map(
          (m, i, a) =>
            `<div class="m ${m.r === 'user' ? 'u' : 'a'}">${m.img ? `<img src="${m.img}">` : ''}${body(m)}${m.r !== 'user' && !m.think ? act(i === a.length - 1) : ''}</div>`
        )
        .join('');
    }
    f.scrollTop = f.scrollHeight;
    sync();
    $('chats').innerHTML = chats
      .map(
        (c, i) =>
          `<button class="btn${c === cur ? ' on' : ''}" data-i="${i}"><svg class="si" viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.5A8 8 0 1 1 21 12z"/></svg><span>${esc(c.title)}</span><i class="x" data-x="${i}" title="Delete chat">×</i></button>`
      )
      .join('');
    $('chatcnt').textContent = String(chats.length);
    $('mccnt').textContent = String(chats.length);
    $('chatsub').textContent = cur
      ? cur.title
      : chats.length
        ? `${chats.length} saved chat${chats.length === 1 ? '' : 's'}`
        : 'Open my chats';
    addFU();
    f.classList.toggle('empty', !cur || !cur.msgs.length);
  }

  function confetti() {
    const c = document.createElement('canvas');
    c.style.cssText = 'position:fixed;inset:0;z-index:99;pointer-events:none';
    c.width = innerWidth;
    c.height = innerHeight;
    document.body.appendChild(c);
    const x = c.getContext('2d')!;
    const st = getComputedStyle(document.documentElement);
    const cols = ['--acc', '--acc2', '--cy', '--pk'].map((v) => st.getPropertyValue(v).trim());
    const P = Array.from({ length: 140 }, () => ({
      x: innerWidth / 2,
      y: innerHeight * 0.6,
      vx: (Math.random() - 0.5) * 16,
      vy: -Math.random() * 15 - 4,
      s: Math.random() * 7 + 4,
      c: cols[(Math.random() * 4) | 0],
      r: Math.random() * 6,
    }));
    let f = 0;
    (function go() {
      x.clearRect(0, 0, c.width, c.height);
      P.forEach((q) => {
        q.vy += 0.35;
        q.x += q.vx;
        q.y += q.vy;
        q.r += 0.2;
        x.fillStyle = q.c;
        x.save();
        x.translate(q.x, q.y);
        x.rotate(q.r);
        x.fillRect(-q.s / 2, -q.s / 4, q.s, q.s / 2);
        x.restore();
      });
      if (++f < 130) requestAnimationFrame(go);
      else c.remove();
    })();
  }

  $('feed').onclick = (e) => {
    const target = e.target as HTMLElement;
    const a = target.closest<HTMLElement>('[data-a]');
    if (a) {
      const el = a.closest('.m');
      if (!el) return;
      const i = [...$('feed').children].indexOf(el);
      const m = cur && cur.msgs[i];
      if (!m) return;
      if (a.dataset.a === 'note') {
        addNote(m);
        return;
      }
      if (a.dataset.a === 'share') {
        shareText(m.t);
        return;
      }
      if (a.dataset.a === 'copy') {
        navigator.clipboard?.writeText(m.t).then(
          () => toast('Copied'),
          () => toast('Could not copy')
        );
      }
      if (a.dataset.a === 'say') {
        if (!window.speechSynthesis) return toast('Read aloud is not supported here');
        if (speechSynthesis.speaking) {
          speechSynthesis.cancel();
          return;
        }
        speechSynthesis.speak(
          new SpeechSynthesisUtterance(m.t.replace(/```[\s\S]*?```/g, ' ').replace(/[*#`|_]/g, ''))
        );
      }
      if (a.dataset.a === 'redo' && cur && i === cur.msgs.length - 1 && i > 0) {
        const u = cur.msgs[i - 1];
        cur.msgs.splice(i - 1, 2);
        $<HTMLTextAreaElement>('q').value = u.t === '(photo)' ? '' : u.t;
        img = u.img || null;
        if (img) {
          $('cam').classList.add('has');
          $('att').style.display = 'block';
        }
        ask();
      }
      return;
    }
    const b = target.closest<HTMLElement>('.sub');
    if (b && b.dataset.s) {
      const on = subjectSelect().value === b.dataset.s;
      subjectSelect().value = on ? 'Any subject' : b.dataset.s;
      subjectSelect().dispatchEvent(new Event('change', { bubbles: true }));
      if (!on && b.dataset.s === 'Off-topic / Casual') {
        mode = 'Chat';
        document.querySelectorAll<HTMLElement>('.mode').forEach((x) => x.classList.toggle('on', x.dataset.m === 'Chat'));
      }
      sync();
      toast(on ? 'Subject cleared' : 'Topic: ' + b.dataset.s);
      $<HTMLTextAreaElement>('q').focus();
    }
  };

  $('chats').onclick = (e) => {
    const target = e.target as HTMLElement;
    const x = target.closest<HTMLElement>('.x');
    if (x) {
      const k = Number(x.dataset.x);
      if (chats[k] === cur) cur = null;
      chats.splice(k, 1);
      save();
      draw();
      return;
    }
    const b = target.closest<HTMLElement>('[data-i]');
    if (b) {
      cur = chats[Number(b.dataset.i)];
      draw();
      closeMyChats();
      $('side').classList.remove('open');
    }
  };

  $('mcnew').onclick = () => {
    cur = null;
    draw();
    closeMyChats();
    $('side').classList.remove('open');
    $<HTMLTextAreaElement>('q').focus();
  };

  $('clr').onclick = $('mcclr').onclick = () => {
    if (!chats.length) return toast('No chats to clear');
    openConfirm('Clear all chats?', 'This removes all saved chats on this device.', 'Clear all', () => {
      chats = [];
      cur = null;
      save();
      draw();
      toast('Chats cleared');
    });
  };

  const DEF: Record<string, number> = { level: 2, subject: 0, lang: 0 };
  function sync() {
    document.querySelectorAll<HTMLElement>('.sub').forEach((b) =>
      b.classList.toggle('on', b.dataset.s === subjectSelect().value)
    );
    for (const id in DEF) {
      const e = $<HTMLSelectElement>(id);
      e.closest('.opt')?.classList.toggle('set', e.selectedIndex !== DEF[id]);
    }
  }

  /* Native values + custom neon dropdown UI stay in sync */
  function buildAkiraSelect(id: string) {
    const select = $<HTMLSelectElement>(id);
    const trigger = document.querySelector<HTMLButtonElement>(`.akira-select-trigger[data-select="${id}"]`);
    const menu = document.querySelector<HTMLDivElement>(`.akira-select-menu[data-menu="${id}"]`);
    if (!select || !trigger || !menu) return;
    const paint = () => {
      const span = trigger.querySelector('.selected-value');
      if (span) span.textContent = select.options[select.selectedIndex]?.text || 'Choose…';
      menu.innerHTML = [...select.options]
        .map(
          (o, i) =>
            `<button type="button" role="option" data-index="${i}" aria-selected="${i === select.selectedIndex}"><span>${o.text}</span><span class="option-check">${i === select.selectedIndex ? '✓' : ''}</span></button>`
        )
        .join('');
    };
    const close = () => {
      menu.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
      document.querySelectorAll('.akira-select-menu.open').forEach((m) => m.classList.remove('open'));
      document
        .querySelectorAll('.akira-select-trigger[aria-expanded=true]')
        .forEach((b) => b.setAttribute('aria-expanded', 'false'));
      menu.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
    };
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      menu.classList.contains('open') ? close() : open();
    });
    menu.addEventListener('click', (e) => {
      const option = (e.target as HTMLElement).closest<HTMLElement>('[role="option"]');
      if (!option) return;
      select.selectedIndex = Number(option.dataset.index);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      paint();
      close();
      trigger.focus();
    });
    select.addEventListener('change', paint);
    paint();
    return { close, paint };
  }
  const akiraSelects = ['level', 'subject', 'lang'].map(buildAkiraSelect);

  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.opt')) {
      document.querySelectorAll('.akira-select-menu.open').forEach((m) => m.classList.remove('open'));
    }
    document.querySelectorAll('.akira-select-trigger').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.akira-select-menu.open').forEach((m) => m.classList.remove('open'));
      document.querySelectorAll('.akira-select-trigger').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    }
  });

  ['level', 'subject', 'lang'].forEach((id) =>
    $(id).addEventListener('change', () => {
      sync();
      if (id === 'subject' && subjectSelect().value === 'Off-topic / Casual') {
        mode = 'Chat';
        document.querySelectorAll<HTMLElement>('.mode').forEach((x) => x.classList.toggle('on', x.dataset.m === 'Chat'));
      }
      try {
        L.akSet = JSON.stringify({
          level: levelSelect().selectedIndex,
          subject: subjectSelect().selectedIndex,
          lang: langSelect().selectedIndex,
          mode,
          hint,
          pics,
        });
      } catch {
        // ignore storage errors
      }
    })
  );

  $('newc').onclick = () => {
    cur = null;
    draw();
    $('side').classList.remove('open');
  };
  $('menu').onclick = (e) => {
    e.stopPropagation();
    $('side').classList.toggle('open');
  };
  $('theme').onclick = () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    L.akTheme = theme;
  };
  $('hint').onclick = (e) => {
    const btn = e.currentTarget as HTMLElement;
    hint = !hint;
    btn.classList.toggle('on', hint);
    btn.setAttribute('aria-pressed', String(hint));
    toast(hint ? 'Hint mode on' : 'Hint mode off');
  };
  $('pics').onclick = (e) => {
    const btn = e.currentTarget as HTMLElement;
    pics = !pics;
    btn.classList.toggle('on', pics);
    btn.setAttribute('aria-pressed', String(pics));
    toast(pics ? 'Diagrams enabled' : 'Diagrams disabled');
  };
  $('cam').onclick = () => $('file').click();
  $<HTMLInputElement>('file').onchange = (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      img = String(r.result || '');
      $('cam').classList.add('has');
      $('att').style.display = 'block';
    };
    r.readAsDataURL(f);
  };
  $('rm').onclick = () => {
    $('cam').classList.remove('has');
    img = null;
    $('att').style.display = 'none';
    $<HTMLInputElement>('file').value = '';
  };
  $('save').onclick = () => {
    if (!cur) return toast('Nothing to save yet');
    const t = cur.msgs.map((m) => (m.r === 'user' ? 'You: ' : 'Akira: ') + m.t).join('\n\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([t], { type: 'text/plain' }));
    a.download = 'akira-chat.txt';
    a.click();
  };
  $('mic').onclick = () => {
    const S = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!S) return toast('Voice input is not supported in this browser');
    const r = new S();
    const b = $('mic');
    r.lang = langSelect().value === 'Hindi' ? 'hi-IN' : 'en-IN';
    b.classList.add('rec');
    r.onresult = (e) => {
      $<HTMLTextAreaElement>('q').value += e.results[0][0].transcript;
    };
    r.onerror = () => toast('Microphone access was interrupted');
    r.onend = () => b.classList.remove('rec');
    r.start();
  };

  /* Hands-free voice conversation */
  let voiceActive = false;
  let voiceRec: SpeechRecognitionInstance | null = null;
  let voiceBusy = false;
  let voiceMuted = false;
  const SpeechRec = win.SpeechRecognition || win.webkitSpeechRecognition;

  function voiceStatus(s: string) {
    $('voiceStatus').textContent = s;
    const speaking = s.toLowerCase().includes('speaking');
    $('voiceHeadline').textContent = speaking
      ? 'Akira is speaking'
      : s.toLowerCase().includes('thinking')
        ? 'Let me think'
        : s.toLowerCase().includes('allow') || s.toLowerCase().includes('microphone issue')
          ? 'Check your microphone'
          : "I'm listening";
    $('voicePanel').classList.toggle('speaking', speaking);
    $('voicePanel').classList.toggle('listening', !speaking && voiceActive && !voiceMuted);
  }

  function stopVoice() {
    voiceActive = false;
    voiceBusy = false;
    voiceMuted = false;
    if (voiceRec) {
      voiceRec.onend = null;
      try {
        voiceRec.stop();
      } catch {
        // ignore
      }
      voiceRec = null;
    }
    if (window.speechSynthesis) speechSynthesis.cancel();
    $('voicePanel').classList.remove('on', 'listening', 'speaking');
    $('voiceToggle').classList.remove('active');
    $('voiceToggle').title = 'Start voice chat';
    $('mic').classList.remove('rec');
  }

  function listenAgain() {
    if (!voiceActive || voiceBusy || !SpeechRec) return;
    try {
      voiceRec = new SpeechRec();
      voiceRec.lang = langSelect().value === 'Hindi' ? 'hi-IN' : 'en-IN';
      voiceRec.continuous = false;
      voiceRec.interimResults = false;
      voiceRec.onstart = () => {
        voiceStatus('Listening… speak naturally');
        $('mic').classList.add('rec');
      };
      voiceRec.onresult = async (e) => {
        const spoken = e.results[0][0].transcript.trim();
        if (!spoken) return;
        $('voiceTranscript').textContent = '“' + spoken + '”';
        $<HTMLTextAreaElement>('q').value = spoken;
        voiceBusy = true;
        voiceStatus('Thinking about your message…');
        await ask();
        const last = cur && cur.msgs[cur.msgs.length - 1];
        if (voiceActive && last && last.r !== 'user' && last.t && window.speechSynthesis) {
          voiceStatus('Akira is speaking…');
          const utter = new SpeechSynthesisUtterance(
            last.t.replace(/```[\s\S]*?```/g, ' ').replace(/[*#`|_]/g, '')
          );
          utter.lang = langSelect().value === 'Hindi' ? 'hi-IN' : 'en-IN';
          utter.onend = () => {
            voiceBusy = false;
            if (voiceActive) {
              voiceStatus('Listening…');
              listenAgain();
            }
          };
          utter.onerror = () => {
            voiceBusy = false;
            if (voiceActive) listenAgain();
          };
          speechSynthesis.cancel();
          speechSynthesis.speak(utter);
        } else {
          voiceBusy = false;
          if (voiceActive) listenAgain();
        }
      };
      voiceRec.onerror = (e) => {
        voiceBusy = false;
        if (voiceActive) {
          voiceStatus(
            e.error === 'not-allowed'
              ? 'Allow microphone access to continue'
              : 'Microphone issue — trying again'
          );
          if (e.error !== 'not-allowed') setTimeout(() => listenAgain(), 700);
        }
      };
      voiceRec.onend = () => {
        $('mic').classList.remove('rec');
        if (voiceActive && !voiceMuted && !voiceBusy && !window.speechSynthesis?.speaking) {
          setTimeout(() => listenAgain(), 350);
        }
      };
      voiceRec.start();
    } catch {
      voiceBusy = false;
      voiceStatus('Could not start microphone. Check browser permissions.');
    }
  }

  $('voiceToggle').onclick = () => {
    if (voiceActive) {
      stopVoice();
      return;
    }
    if (!SpeechRec || !window.speechSynthesis) {
      return toast('Voice chat needs a browser with speech recognition and speech synthesis');
    }
    voiceActive = true;
    voiceMuted = false;
    $('voiceTranscript').textContent = 'Your conversation will appear here';
    $('voiceMute').classList.remove('muted');
    const lbl = $('voiceMute').querySelector('small');
    if (lbl) lbl.textContent = 'Mute';
    $('voicePanel').classList.add('on', 'listening');
    $('voiceToggle').classList.add('active');
    $('voiceToggle').title = 'Voice chat is active';
    voiceStatus('Starting microphone…');
    listenAgain();
  };
  $('voiceStop').onclick = stopVoice;
  $('voiceClose').onclick = stopVoice;
  $('voiceMute').onclick = () => {
    voiceMuted = !voiceMuted;
    $('voiceMute').classList.toggle('muted', voiceMuted);
    const lbl = $('voiceMute').querySelector('small');
    if (lbl) lbl.textContent = voiceMuted ? 'Unmute' : 'Mute';
    $('voiceMute').setAttribute('aria-label', voiceMuted ? 'Unmute microphone' : 'Mute microphone');
    if (voiceMuted) {
      if (voiceRec) {
        voiceRec.onend = null;
        try {
          voiceRec.stop();
        } catch {
          // ignore
        }
        voiceRec = null;
      }
      voiceStatus('Microphone muted');
      $('voicePanel').classList.remove('listening');
      $('mic').classList.remove('rec');
    } else {
      voiceStatus('Listening… speak naturally');
      listenAgain();
    }
  };

  /* focus timer */
  let t = 1500;
  let iv: number | null = null;
  const fb = $('fbar').firstChild as HTMLElement;
  $('focus').onclick = () => {
    if (iv) {
      clearInterval(iv);
      iv = null;
      t = 1500;
      $('ft').textContent = 'Focus 25:00';
      fb.style.width = '0';
      return;
    }
    toast('Focus started. You got this');
    iv = window.setInterval(() => {
      t--;
      $('ft').textContent = 'Focus ' + String((t / 60) | 0).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
      fb.style.width = (1500 - t) / 15 + '%';
      if (t <= 0) {
        if (iv) clearInterval(iv);
        iv = null;
        t = 1500;
        fb.style.width = '0';
        $('ft').textContent = 'Focus 25:00';
        const d = new Date().toDateString();
        const o = JSON.parse(L.akFocus || '{}') as { d?: string; n?: number };
        const n = (o.d === d ? o.n || 0 : 0) + 1;
        L.akFocus = JSON.stringify({ d, n });
        bump('f');
        confetti();
        toast('Session ' + n + ' done today. Take a 5 minute break');
      }
    }, 1000);
  };

  const qInput = $<HTMLTextAreaElement>('q');
  qInput.addEventListener('input', (e) => {
    const el = e.target as HTMLTextAreaElement;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  });
  qInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask();
    }
  });
  $('ask').onclick = () => {
    if (gen) stopGen();
    else ask();
  };

  /* typed placeholder */
  const EX = [
    'Explain quantum computing in simple terms',
    'I need a break from studying — what is a great sci-fi movie to watch?',
    'Solve 3x + 7 = 22 step by step',
    'Let’s just talk! How would you spend a rainy weekend?',
    'Quiz me on the water cycle',
    'Draw the parts of a plant cell',
  ];
  let ei = 0;
  let ci = 0;
  let dir = 1;
  setInterval(() => {
    const s = EX[ei];
    ci += dir;
    if (ci > s.length + 14) dir = -1;
    if (ci <= 0) {
      dir = 1;
      ei = (ei + 1) % EX.length;
    }
    qInput.placeholder = 'Example: “' + s.slice(0, Math.max(0, Math.min(ci, s.length))) + '|”';
  }, 70);

  function friendly(e: unknown): string {
    const m = String((e as { message?: string })?.message || e).trim();
    if (/429|rate|quota|too many|busy right now|high demand/i.test(m)) {
      return 'Akira is a bit busy right now. Wait a few seconds and try again.';
    }
    if (/failed to fetch|network|offline/i.test(m)) {
      return "Can't reach the AI. Check your internet connection and try again.";
    }
    if (/^(Invalid|GEMINI_API_KEY|Could not reach|That photo)/i.test(m)) {
      return m;
    }
    return m || 'Something went wrong. Please try again.';
  }

  function stopGen() {
    if (!gen || !cur) return;
    const b = cur.msgs[cur.msgs.length - 1];
    if (!b || b.r === 'user') return;
    b.stopped = true;
    activeAbort?.abort();
    activeAbort = null;
    if (b.think && !b.t) {
      cur.msgs.splice(cur.msgs.indexOf(b), 1);
    } else {
      b.think = false;
    }
    gen = false;
    document.body.classList.remove('gen', 'busy');
    save();
    draw();
    toast('Stopped');
  }

  async function ask() {
    if (gen) return;
    const q = qInput.value.trim();
    if (!q && !img) return;
    if (!cur) {
      cur = { title: (q || 'Photo question').slice(0, 34), msgs: [] };
      chats.unshift(cur);
    }
    const photo = img;
    cur.msgs.push({ r: 'user', t: q || '(photo)', img: photo });
    bump('q');
    qInput.value = '';
    qInput.style.height = 'auto';
    $('rm').click();

    const langChoice = langSelect().value;
    const langInstruction =
      langChoice === 'Same as my question' ? 'the same language as the user’s message' : langChoice;
    const isCasualMode = mode === 'Chat' || subjectSelect().value === 'Off-topic / Casual';

    const sys = [
      'You are Akira, a friendly, warm, and adaptable AI companion and study assistant.',
      `Answer language: ${langInstruction}.`,
      `Student level context (for academic questions): ${levelSelect().value}.`,
      `Selected subject/topic: ${subjectSelect().value}.`,
      `Current mode: ${mode} — ${MODES[mode][1]}`,
      isCasualMode
        ? 'The user is in casual Chat mode. Talk naturally like an insightful, approachable friend about whatever they bring up — life, hobbies, movies, games, feelings, jokes, or random thoughts — without forcing homework structure, quizzes, or study diagrams unless they ask.'
        : 'Important: If the user wants to talk about something OTHER than studies (casual chat, feelings, hobbies, entertainment, life advice, humor, or everyday topics), respond naturally and conversationally to what they want to talk about instead of forcing a study format or redirecting them back to homework.',
      hint && !isCasualMode
        ? 'Hint mode (for study problems): do NOT give away the full final answer immediately; guide with helpful hints and questions step by step.'
        : '',
      pics && !isCasualMode
        ? 'For study concepts where a visual helps, you may include tables or clean inline SVG diagrams inside ```svg blocks.'
        : 'Do not include SVG diagrams unless explicitly asked.',
      'Keep responses clear, genuine, and age-appropriate.',
    ]
      .filter(Boolean)
      .join(' ');

    const hist = cur.msgs
      .filter(
        (m) =>
          !m.think &&
          !/^(Something went wrong|Too many questions|Akira is a bit busy|Can't reach the AI|Could not reach Akira|Invalid or unauthorized)/i.test(
            m.t
          )
      )
      .map((m) => ({
        role: m.r === 'user' ? 'user' : 'assistant',
        content: m.t,
        img: m.img,
      }));

    const box: ChatMessage = { r: 'model', t: '', think: true };
    cur.msgs.push(box);
    gen = true;
    activeAbort = new AbortController();
    document.body.classList.add('gen', 'busy');
    draw();

    const feedEl = $('feed');
    let ans = '';
    try {
      ans = await callAI({
        system: sys,
        messages: hist,
        image: photo,
        mode,
        signal: activeAbort.signal,
        onChunk: (partial) => {
          if (box.stopped) return;
          if (box.think) {
            box.think = false;
            document.body.classList.remove('busy');
          }
          box.t = partial;
          const lastMsgEl = feedEl.lastElementChild as HTMLElement | null;
          if (lastMsgEl && lastMsgEl.classList.contains('a')) {
            lastMsgEl.innerHTML = md(box.t);
            feedEl.scrollTop = feedEl.scrollHeight;
          }
        },
      });
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError' || box.stopped) {
        return;
      }
      ans = friendly(e);
    } finally {
      activeAbort = null;
    }

    if (box.stopped) return;
    document.body.classList.remove('busy');
    box.think = false;
    box.t = ans;
    gen = false;
    document.body.classList.remove('gen');
    save();
    draw();
  }

  /* ---- page format ---- */
  const FD: FormatSettings = {
    fs: 16,
    lh: '1.6',
    ff: 'modern',
    layout: 'bubbles',
    fx: 'full',
    cur: 'glow',
  };
  const FF: Record<string, string> = {
    modern: "'Exo 2',system-ui,sans-serif",
    clean: "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
    serif: "Georgia,'Times New Roman',serif",
  };
  let F: FormatSettings = { ...FD };
  try {
    F = { ...FD, ...JSON.parse(L.akFmt || '{}') };
  } catch {
    F = { ...FD };
  }

  function fmtApply() {
    const r = document.documentElement.style;
    r.setProperty('--fs', F.fs + 'px');
    r.setProperty('--lh', F.lh);
    r.setProperty('--ff', FF[F.ff] || FF.modern);
    document.body.classList.toggle('plain', F.layout === 'plain');
    document.body.classList.toggle('lite', F.fx === 'lite');
    $<HTMLInputElement>('fs').value = String(F.fs);
    $('fsv').textContent = F.fs + 'px';
    document.querySelectorAll<HTMLElement>('#fmt .seg').forEach((g) =>
      g.querySelectorAll<HTMLElement>('button').forEach((b) =>
        b.classList.toggle('on', b.dataset.v === String(F[g.dataset.k as keyof FormatSettings]))
      )
    );
    L.akFmt = JSON.stringify(F);
    win.curApply?.();
  }

  const mob = () => innerWidth <= 760;
  function upd() {
    $('bd').classList.toggle(
      'on',
      (mob() && $('side').classList.contains('open')) ||
        $('fmt').classList.contains('on') ||
        $('notes').classList.contains('on') ||
        $('mychats').classList.contains('on')
    );
  }
  const openFmt = () => {
    closeMyChats();
    $('fmt').classList.add('on');
    upd();
  };
  const closeFmt = () => {
    $('fmt').classList.remove('on');
    upd();
  };
  const openMyChats = () => {
    closeFmt();
    closeNotes();
    if (mob()) $('side').classList.remove('open');
    $('mychats').classList.add('on');
    $('chatstab').classList.add('on');
    $('chatstab').setAttribute('aria-expanded', 'true');
    upd();
  };
  const closeMyChats = () => {
    $('mychats').classList.remove('on');
    $('chatstab').classList.remove('on');
    $('chatstab').setAttribute('aria-expanded', 'false');
    upd();
  };

  new MutationObserver(upd).observe($('side'), { attributes: true, attributeFilter: ['class'] });
  $('chatstab').onclick = (e) => {
    e.stopPropagation();
    $('mychats').classList.contains('on') ? closeMyChats() : openMyChats();
  };
  $('mcclose').onclick = closeMyChats;
  $('fmtb').onclick = (e) => {
    e.stopPropagation();
    closeNotes();
    $('fmt').classList.contains('on') ? closeFmt() : openFmt();
  };
  $('fclose').onclick = closeFmt;
  $('bd').onclick = () => {
    closeNotes();
    closeFmt();
    closeMyChats();
    $('side').classList.remove('open');
  };
  $('fmt').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.seg button');
    if (b && b.dataset.v) {
      const k = (b.parentNode as HTMLElement).dataset.k as keyof FormatSettings;
      if (k !== 'fs') {
        F[k] = b.dataset.v;
        fmtApply();
      }
    }
  });
  $<HTMLInputElement>('fs').oninput = (e) => {
    F.fs = Number((e.target as HTMLInputElement).value);
    fmtApply();
  };
  $('frst').onclick = () => {
    F = { ...FD };
    fmtApply();
    toast('Format reset');
  };
  fmtApply();

  /* ---- mobile: keyboard fit + swipe gestures ---- */
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const fit = () => {
      const m = mob();
      document.body.style.height = m ? vv.height + 'px' : '';
      document.body.classList.toggle('kb', m && vv.height < innerHeight * 0.75);
      if (m) scrollTo(0, 0);
    };
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', () => {
      if (mob()) scrollTo(0, 0);
    });
    fit();
  }

  let tx = 0;
  let ty = 0;
  addEventListener(
    'touchstart',
    (e) => {
      tx = e.touches[0].clientX;
      ty = e.touches[0].clientY;
    },
    { passive: true }
  );
  addEventListener(
    'touchend',
    (e) => {
      const dx = e.changedTouches[0].clientX - tx;
      const dy = e.changedTouches[0].clientY - ty;
      if (!mob()) return;
      const sd = $('side');
      if (Math.abs(dx) > 70 && Math.abs(dy) < 60) {
        if (dx > 0 && tx < 28) sd.classList.add('open');
        if (dx < 0 && sd.classList.contains('open')) sd.classList.remove('open');
      }
      if (
        dy > 60 &&
        Math.abs(dx) < 50 &&
        (e.target as HTMLElement).closest('#fmt') &&
        ty < innerHeight - $('fmt').offsetHeight + 70
      ) {
        closeFmt();
      }
      if (
        dy > 60 &&
        Math.abs(dx) < 50 &&
        (e.target as HTMLElement).closest('#mychats') &&
        ty < innerHeight - $('mychats').offsetHeight + 70
      ) {
        closeMyChats();
      }
    },
    { passive: true }
  );

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/TEXTAREA|SELECT|INPUT/.test(document.activeElement?.tagName || '')) {
      e.preventDefault();
      qInput.focus();
    }
    if (e.key === 'Escape') {
      $('side').classList.remove('open');
      closeFmt();
      closeMyChats();
    }
  });
  document.querySelector('main')?.addEventListener('click', () => $('side').classList.remove('open'));

  const persist = () => {
    L.akSet = JSON.stringify({
      level: levelSelect().selectedIndex,
      subject: subjectSelect().selectedIndex,
      lang: langSelect().selectedIndex,
      mode,
      hint,
      pics,
    });
  };
  ['click', 'change'].forEach((ev) => document.addEventListener(ev, () => setTimeout(persist, 0)));

  try {
    const o = JSON.parse(L.akSet || '{}');
    if (o.level != null) {
      levelSelect().selectedIndex = o.level;
      subjectSelect().selectedIndex = o.subject;
      langSelect().selectedIndex = o.lang;
      mode = o.mode && MODES[o.mode] ? o.mode : mode;
      hint = !!o.hint;
      pics = o.pics !== false;
      document.querySelectorAll<HTMLElement>('.mode').forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
      $('hint').classList.toggle('on', hint);
      $('pics').classList.toggle('on', pics);
      akiraSelects.forEach((s) => s?.paint());
    }
  } catch {
    // ignore invalid saved settings
  }

  /* ---- follow-up chips ---- */
  function addFU() {
    const f = $('feed');
    f.querySelectorAll('.fu').forEach((x) => x.remove());
    if (gen || !cur || !cur.msgs.length) return;
    const m = cur.msgs[cur.msgs.length - 1];
    if (m.r === 'user' || m.think || /^(Something went wrong|Too many|Can't reach)/.test(m.t)) return;

    const isCasual = mode === 'Chat' || subjectSelect().value === 'Off-topic / Casual';
    const P: [string, string][] = isCasual
      ? [
          ['Tell me more', 'Tell me more about that!'],
          ['Hot take?', 'What’s an interesting angle or hot take on this?'],
          ['Ask me back', 'Ask me a fun follow-up question about this.'],
          ['Switch to study', 'Okay, let’s switch gears and study something now!'],
        ]
      : [
          ['Explain simpler', 'Explain that again in simpler words.'],
          ['Give an example', 'Give me a real-life example of that.'],
          ['Test me', 'Test me with 3 quick questions on this, one at a time.'],
          ['Summarise', 'Summarise that in 3 short bullet points.'],
        ];

    const d = document.createElement('div');
    d.className = 'fu';
    d.innerHTML = P.map((p) => `<button data-p="${p[1]}">${p[0]}</button>`).join('');
    f.appendChild(d);
    f.scrollTop = f.scrollHeight;
  }

  $('feed').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.fu button');
    if (b && b.dataset.p && !gen) {
      qInput.value = b.dataset.p;
      ask();
    }
  });

  /* ---- notes ---- */
  const notes = (): NoteItem[] => {
    try {
      return JSON.parse(L.akNotes || '[]');
    } catch {
      return [];
    }
  };
  const setNotes = (a: NoteItem[]) => {
    L.akNotes = JSON.stringify(a.slice(0, 200));
  };
  function addNote(m: ChatMessage) {
    const a = notes();
    if (a.some((n) => n.t === m.t)) return toast('Already in your notes');
    a.unshift({ t: m.t, d: new Date().toLocaleDateString(), s: subjectSelect().value });
    setNotes(a);
    toast('Saved to notes');
  }
  function renderNotes() {
    const a = notes();
    $('nlist').innerHTML = a.length
      ? a
          .map(
            (n, i) =>
              `<div class="nt-item"><div class="nt-t">${md(n.t)}</div><div class="nt-m">${esc(n.d)}${n.s && n.s !== 'Any subject' ? ' · ' + esc(n.s) : ''}</div><div class="nt-act"><button data-n="copy" data-i="${i}">Copy</button><button data-n="del" data-i="${i}">Delete</button></div></div>`
          )
          .join('')
      : `<p class="mut">Nothing saved yet. Tap the bookmark under any answer to keep it here.</p>`;
  }
  function openNotes() {
    closeFmt();
    closeMyChats();
    renderNotes();
    $('notes').classList.add('on');
    upd();
  }
  function closeNotes() {
    $('notes').classList.remove('on');
    upd();
  }
  $('notesb').onclick = (e) => {
    e.stopPropagation();
    $('notes').classList.contains('on') ? closeNotes() : openNotes();
  };
  $('nclose').onclick = closeNotes;
  $('nlist').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-n]');
    if (!b) return;
    const a = notes();
    const i = Number(b.dataset.i);
    if (b.dataset.n === 'copy') {
      navigator.clipboard?.writeText(a[i].t).then(() => toast('Copied'));
    } else {
      a.splice(i, 1);
      setNotes(a);
      renderNotes();
    }
  };
  function dl(name: string, text: string, type: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  $('nexp').onclick = () => {
    const a = notes();
    if (!a.length) return toast('No notes to export');
    dl(
      'akira-notes.md',
      '# Akira notes\n\n' +
        a
          .map((n) => '## ' + n.d + (n.s && n.s !== 'Any subject' ? ' · ' + n.s : '') + '\n\n' + n.t)
          .join('\n\n---\n\n'),
      'text/markdown'
    );
  };
  const KEYS = ['akChats', 'akNotes', 'akFmt', 'akSet', 'akStats', 'akFocus', 'akPal', 'akTheme', 'akTour'];
  $('nbk').onclick = () => {
    const o: Record<string, string> = {};
    KEYS.forEach((k) => {
      if (L[k] != null) o[k] = L[k];
    });
    dl('akira-backup.json', JSON.stringify(o), 'application/json');
    toast('Backup downloaded');
  };
  $('nrs').onclick = () => $('nfile').click();
  $<HTMLInputElement>('nfile').onchange = (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const o = JSON.parse(String(r.result || ''));
        openConfirm(
          'Restore backup?',
          'This replaces your current saved chats and notes on this device.',
          'Restore',
          () => {
            KEYS.forEach((k) => {
              if (typeof o[k] === 'string') L[k] = o[k];
            });
            location.reload();
          }
        );
      } catch {
        toast('That file is not a valid backup');
      }
    };
    r.readAsText(f);
  };
  async function shareText(t: string) {
    const c = t.replace(/[*#`]/g, '');
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Akira AI', text: c });
        return;
      }
      await navigator.clipboard.writeText(c);
      toast('Copied, ready to share');
    } catch {
      // ignore cancelled share
    }
  }

  /* study stats: streak, daily goal, exam countdown */
  const GOAL = 10;
  const dkey = (d = new Date()) => d.toLocaleDateString('en-CA');
  const stats = (): StudyStats => {
    try {
      return JSON.parse(L.akStats || '{}');
    } catch {
      return {};
    }
  };
  const pts = (d: StudyDay) => d.q + d.f * 5;
  function bump(kind: 'q' | 'f') {
    const s = stats();
    s.days = s.days || {};
    const d = (s.days[dkey()] = s.days[dkey()] || { q: 0, f: 0 });
    const g = s.goal || GOAL;
    const b = pts(d);
    if (kind === 'f') d.f++;
    else d.q++;
    L.akStats = JSON.stringify(s);
    renderStats();
    if (b < g && pts(d) >= g) {
      confetti();
      toast('Daily goal reached. Great work!');
    }
  }
  function streak(s: StudyStats) {
    let n = 0;
    const dt = new Date();
    const has = (k: string) => {
      const d = (s.days || {})[k];
      return !!(d && (d.q > 0 || d.f > 0));
    };
    if (!has(dkey(dt))) dt.setDate(dt.getDate() - 1);
    while (has(dkey(dt))) {
      n++;
      dt.setDate(dt.getDate() - 1);
    }
    return n;
  }
  function fmtDate(k: string) {
    return new Date(k + 'T00:00').toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }
  function renderStats() {
    const s = stats();
    const d = (s.days || {})[dkey()] || { q: 0, f: 0 };
    const g = s.goal || GOAL;
    const p = Math.min(pts(d), g);
    $('sring').style.strokeDashoffset = String(138.23 * (1 - p / g));
    $('spts').textContent = pts(d) + '/' + g;
    $('sstreak').textContent = String(streak(s));
    let ex = 'Type or pick your exam date';
    if (s.exam) {
      const n = Math.round(
        (new Date(s.exam + 'T00:00').getTime() - new Date(dkey() + 'T00:00').getTime()) / 864e5
      );
      ex =
        n > 1
          ? 'Exam in ' + n + ' days'
          : n === 1
            ? 'Exam is tomorrow'
            : n === 0
              ? "Exam is today. You've got this"
              : 'Exam date has passed';
    }
    $('sexam').textContent = ex;
    $<HTMLInputElement>('exd').value = s.exam || '';
    if (document.activeElement !== $('exdt')) {
      $<HTMLInputElement>('exdt').value = s.exam ? fmtDate(s.exam) : '';
    }
  }
  $<HTMLInputElement>('exd').onchange = (e) => {
    const s = stats();
    s.exam = (e.target as HTMLInputElement).value;
    L.akStats = JSON.stringify(s);
    renderStats();
  };
  $('sgoal').onclick = () => {
    const s = stats();
    openGoalPrompt(s.goal || GOAL, (val) => {
      s.goal = val;
      L.akStats = JSON.stringify(s);
      renderStats();
      toast('Daily goal updated to ' + val + ' pts');
    });
  };

  /* tour + shortcuts + in-app confirm/prompt dialogs (no native alert/confirm/prompt) */
  const TOUR: [string, string][] = [
    [
      '👋 Welcome to Akira',
      'Pick a subject tile and a mode like Homework, Explain or Quiz — or choose Chat to talk about anything outside of studies.',
    ],
    [
      '🎤 Type, speak or snap',
      'Use the camera for a photo of a question, the mic to dictate, or the wave button for hands-free voice chat.',
    ],
    [
      '⚙️ Make it yours',
      'Aa changes text size and fonts, the bookmark keeps your best answers, and the Today card tracks your streak and exam countdown.',
    ],
  ];
  let mstep = 0;
  let mkind: 'tour' | 'keys' | 'confirm' | 'goal' = 'tour';
  let onModalConfirm: (() => void) | null = null;
  let onGoalSave: ((val: number) => void) | null = null;

  function openMdl(k: 'tour' | 'keys') {
    mkind = k;
    mstep = 0;
    onModalConfirm = null;
    onGoalSave = null;
    $('mdl').classList.add('on');
    mdraw();
  }
  function openConfirm(title: string, desc: string, confirmLabel: string, cb: () => void) {
    mkind = 'confirm';
    onModalConfirm = cb;
    onGoalSave = null;
    $('mskip').style.display = '';
    $('mskip').textContent = 'Cancel';
    $('mdots').style.display = 'none';
    $('mbody').innerHTML = `<h3>${esc(title)}</h3><p>${esc(desc)}</p>`;
    $('mnext').textContent = confirmLabel;
    $('mdl').classList.add('on');
  }
  function openGoalPrompt(current: number, cb: (val: number) => void) {
    mkind = 'goal';
    onGoalSave = cb;
    onModalConfirm = null;
    $('mskip').style.display = '';
    $('mskip').textContent = 'Cancel';
    $('mdots').style.display = 'none';
    $('mbody').innerHTML = `<h3>Daily goal</h3><p>1 message = 1 point, 1 focus session = 5 points.</p><input id="goalInp" class="mdl-inp" type="number" min="1" max="200" value="${current}" />`;
    $('mnext').textContent = 'Save';
    $('mdl').classList.add('on');
    setTimeout(() => $<HTMLInputElement>('goalInp')?.focus(), 50);
  }
  function closeMdl() {
    $('mdl').classList.remove('on');
    if (mkind === 'tour') L.akTour = '1';
    $('mskip').textContent = 'Skip';
  }
  function mdraw() {
    const isTour = mkind === 'tour';
    $('mskip').style.display = isTour ? '' : 'none';
    $('mskip').textContent = 'Skip';
    $('mdots').style.display = isTour ? '' : 'none';
    if (isTour) {
      const s = TOUR[mstep];
      $('mbody').innerHTML = `<h3>${s[0]}</h3><p>${s[1]}</p>`;
      $('mdots').innerHTML = TOUR.map((_, i) => `<i class="${i === mstep ? 'on' : ''}"></i>`).join('');
      $('mnext').textContent = mstep === TOUR.length - 1 ? "Let's go" : 'Next';
    } else {
      $('mbody').innerHTML =
        '<h3>Shortcuts</h3><ul><li><kbd>/</kbd>Jump to the message box</li><li><kbd>Enter</kbd>Send &nbsp; <kbd>Shift</kbd>+<kbd>Enter</kbd>New line</li><li><kbd>Ctrl</kbd>+<kbd>K</kbd>New chat</li><li><kbd>Esc</kbd>Close panels</li><li><kbd>?</kbd>Show this list</li></ul>';
      $('mnext').textContent = 'Got it';
    }
  }
  $('mnext').onclick = () => {
    if (mkind === 'tour' && mstep < TOUR.length - 1) {
      mstep++;
      mdraw();
    } else if (mkind === 'confirm') {
      const fn = onModalConfirm;
      closeMdl();
      fn?.();
    } else if (mkind === 'goal') {
      const v = parseInt($<HTMLInputElement>('goalInp')?.value || '', 10);
      if (v > 0 && v <= 200) {
        const fn = onGoalSave;
        closeMdl();
        fn?.(v);
      } else {
        toast('Enter a number between 1 and 200');
      }
    } else {
      closeMdl();
    }
  };
  $('mskip').onclick = closeMdl;
  $('mdl').addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'mdl') closeMdl();
  });
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName || '';
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('newc').click();
      qInput.focus();
    }
    if (e.key === '?' && !/TEXTAREA|INPUT|SELECT/.test(tag)) {
      e.preventDefault();
      openMdl('keys');
    }
    if (e.key === 'Escape') {
      closeNotes();
      if ($('mdl').classList.contains('on')) closeMdl();
    }
  });
  if (!L.akTour) {
    setTimeout(() => {
      if (!$('voicePanel').classList.contains('on')) openMdl('tour');
    }, 900);
  }

  /* swipe rows: mouse wheel and drag still scroll them, no visible scrollbar */
  (function () {
    let el: HTMLElement | null = null;
    let sx = 0;
    let sl = 0;
    let moved = false;
    const SEL = '.modes,.subs,.opts';
    document.addEventListener(
      'wheel',
      (e) => {
        const t = (e.target as HTMLElement).closest?.(SEL) as HTMLElement | null;
        if (!t || t.scrollWidth <= t.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        t.scrollLeft += e.deltaY;
        e.preventDefault();
      },
      { passive: false }
    );
    document.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') return;
      el = (e.target as HTMLElement).closest?.(SEL) as HTMLElement | null;
      moved = false;
      if (el) {
        sx = e.clientX;
        sl = el.scrollLeft;
      }
    });
    addEventListener('pointermove', (e) => {
      if (!el) return;
      const dx = e.clientX - sx;
      if (Math.abs(dx) > 6) moved = true;
      if (moved) el.scrollLeft = sl - dx;
    });
    addEventListener('pointerup', () => {
      el = null;
    });
    document.addEventListener(
      'click',
      (e) => {
        if (moved) {
          e.stopPropagation();
          e.preventDefault();
          moved = false;
        }
      },
      true
    );
  })();

  /* ---- exam date ---- */
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function parseDate(t: string): string | null {
    t = t
      .trim()
      .toLowerCase()
      .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
      .replace(/,/g, ' ');
    if (!t) return '';
    let d: number;
    let m: number;
    let y: number;
    let r: RegExpMatchArray | null;
    if ((r = t.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/))) {
      y = +r[1];
      m = +r[2];
      d = +r[3];
    } else if ((r = t.match(/^(\d{1,2})[-\/.](\d{1,2})(?:[-\/.](\d{2,4}))?$/))) {
      d = +r[1];
      m = +r[2];
      y = r[3] ? +r[3] : 0;
    } else if ((r = t.match(/^(\d{1,2})\s*([a-z]{3,})\.?\s*(\d{2,4})?$/))) {
      d = +r[1];
      m = MON.indexOf(r[2].slice(0, 3)) + 1;
      y = r[3] ? +r[3] : 0;
    } else if ((r = t.match(/^([a-z]{3,})\.?\s*(\d{1,2})\s*(\d{2,4})?$/))) {
      m = MON.indexOf(r[1].slice(0, 3)) + 1;
      d = +r[2];
      y = r[3] ? +r[3] : 0;
    } else return null;

    if (m > 12 && d <= 12) [d, m] = [m, d];
    if (y && y < 100) y += 2000;
    if (!m || m > 12 || !d || d > 31) return null;
    const n = new Date();
    const td = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    if (!y) {
      y = n.getFullYear();
      if (new Date(y, m - 1, d) < td) y++;
    }
    const dt = new Date(y, m - 1, d);
    if (dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return dkey(dt);
  }
  function setExam(v: string) {
    const k = parseDate(v);
    const el = $('exdt');
    if (k === null) {
      el.classList.remove('bad');
      void el.offsetWidth;
      el.classList.add('bad');
      toast("Couldn't read that date. Try 25/12/2026");
      return;
    }
    const s = stats();
    if (k) s.exam = k;
    else delete s.exam;
    L.akStats = JSON.stringify(s);
    el.classList.remove('bad');
    renderStats();
  }
  $('exdt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setExam($<HTMLInputElement>('exdt').value);
      $('exdt').blur();
    }
  });
  $('exdt').addEventListener('change', () => setExam($<HTMLInputElement>('exdt').value));
  $('exd').addEventListener('click', () => {
    try {
      $<HTMLInputElement>('exd').showPicker();
    } catch {
      // ignore if unsupported
    }
  });

  renderStats();
  draw();

  /* ---- aurora cursor ---- */
  (function () {
    if (!matchMedia('(hover:hover) and (pointer:fine)').matches) return;
    const rm = matchMedia('(prefers-reduced-motion:reduce)').matches;
    const dot = document.createElement('div');
    const ring = document.createElement('div');
    const ctrail = document.createElement('canvas');
    dot.id = 'cdot';
    ring.id = 'cring';
    ctrail.id = 'ctrail';
    document.body.append(ctrail, ring, dot);
    const g = ctrail.getContext('2d')!;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    let cw = 0;
    let ch = 0;
    function resizeTrail() {
      cw = innerWidth;
      ch = innerHeight;
      ctrail.width = cw * dpr;
      ctrail.height = ch * dpr;
      ctrail.style.width = cw + 'px';
      ctrail.style.height = ch + 'px';
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resizeTrail();
    addEventListener('resize', resizeTrail);

    let pmx = 0;
    let pmy = 0;
    let rx = 0;
    let ry = 0;
    let hov = false;
    let vis = false;
    let raf = 0;
    let last = 0;
    const P: { x: number; y: number; vx: number; vy: number; l: number; d: number; s: number; c: string }[] = [];
    let C = ['#52f0ff', '#4f7bff', '#9a5cff', '#ff7ad9'];
    const readC = () => {
      const s = getComputedStyle(document.documentElement);
      C = ['--cy', '--acc', '--acc2', '--pk'].map((v) => s.getPropertyValue(v).trim() || '#fff');
    };
    readC();
    setInterval(readC, 1500);

    const IA =
      'a,button,label,summary,[role=button],.btn,.pill,.tool,.chip,.opt,.mode,.sub,.sw i,.seg button,.go,.vmic,.act button,.fu button,.nt-act button,#mdl button,.rngbtn,.calbtn,.x,input[type=range]';
    const TXT = 'textarea,input[type=text],input[type=password],input[type=search],input:not([type])';
    const enabled = () => F.cur !== 'off';
    const R = document.documentElement;

    function spawn(x: number, y: number, n: number, sp: number) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.283;
        const v = Math.random() * sp;
        P.push({
          x,
          y,
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v - 0.2,
          l: 1,
          d: 0.016 + Math.random() * 0.02,
          s: 2 + Math.random() * 3.5,
          c: C[(Math.random() * 4) | 0],
        });
      }
      if (P.length > 170) P.splice(0, P.length - 170);
    }

    function loop() {
      raf = 0;
      if (!vis || !enabled()) return;
      const k = hov ? 0.6 : 0.18;
      rx += (pmx - rx) * k;
      ry += (pmy - ry) * k;
      dot.style.transform = `translate3d(${pmx}px,${pmy}px,0) translate(-50%,-50%)`;
      ring.style.transform = `translate3d(${rx}px,${ry}px,0) translate(-50%,-50%)`;
      g.clearRect(0, 0, cw, ch);
      g.globalCompositeOperation = R.dataset.theme === 'light' ? 'source-over' : 'lighter';
      for (let i = P.length - 1; i >= 0; i--) {
        const p = P[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.98;
        p.vy += 0.012;
        p.l -= p.d;
        if (p.l <= 0) {
          P.splice(i, 1);
          continue;
        }
        g.globalAlpha = p.l * 0.9;
        g.fillStyle = p.c;
        g.shadowColor = p.c;
        g.shadowBlur = 12;
        g.beginPath();
        g.arc(p.x, p.y, Math.max(0.1, p.s * p.l), 0, 6.283);
        g.fill();
      }
      g.globalAlpha = 1;
      g.shadowBlur = 0;
      raf = requestAnimationFrame(loop);
    }

    addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType !== 'mouse' || !enabled()) return;
        pmx = e.clientX;
        pmy = e.clientY;
        if (!vis) {
          vis = true;
          rx = pmx;
          ry = pmy;
          R.classList.add('ck');
        }
        const t = e.target as HTMLElement;
        const txt = !!t.closest?.(TXT);
        const h = !txt && !!t.closest?.(IA);
        hov = h;
        dot.classList.toggle('h', h);
        ring.classList.toggle('h', h);
        dot.style.opacity = ring.style.opacity = txt ? '0' : '1';
        const n = performance.now();
        if (!rm && n - last > 16 && !txt && !h) {
          spawn(pmx, pmy, 1, 0.7);
          last = n;
        }
        if (!raf) raf = requestAnimationFrame(loop);
      },
      { passive: true }
    );
    addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || !vis || !enabled()) return;
      dot.classList.add('d');
      ring.classList.add('d');
      if (!rm) spawn(e.clientX, e.clientY, 18, 4.5);
    });
    addEventListener('pointerup', () => {
      dot.classList.remove('d');
      ring.classList.remove('d');
    });
    R.addEventListener('mouseleave', () => {
      dot.style.opacity = ring.style.opacity = '0';
    });
    R.addEventListener('mouseenter', () => {
      if (vis && enabled()) dot.style.opacity = ring.style.opacity = '1';
    });
    win.curApply = () => {
      const on = enabled();
      R.classList.toggle('ck', on && vis);
      dot.style.display = ring.style.display = ctrail.style.display = on ? '' : 'none';
      if (!on) {
        P.length = 0;
        vis = false;
        R.classList.remove('ck');
      }
    };
    win.curApply();
  })();
}
