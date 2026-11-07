// note の記事本文を、Edge 内蔵の LLM（Prompt API）で論文風の構成に書き換える。
// 構成: タイトル → 要約 → 目次 → 本文（節ごとに、各段落の最初の文が段落の要点になる書き方）

(() => {
  const ARTICLE_PATH = /^\/[^/]+\/n\/[^/]+/;
  const BODY_SELECTOR = '#note-body, [data-name="body"]';

  const SYSTEM_PROMPT = `あなたは学術論文の編集者です。与えられた日本語の文章を、論文のように読みやすい日本語に書き直します。
守ること:
- 段落ごとに、最初の一文でその段落の主張を言い切る（トピックセンテンス）。続く文は、その主張の理由・具体例・補足だけにする。
- 各段落の最初の文だけを順に読めば、全体の内容がわかるようにする。
- 元の文章の事実・主張・数字は変えない。書かれていないことを足さない。
- 話し言葉、絵文字、呼びかけ、繰り返しは削り、「である」調で書く。
- 出力は日本語だけにする。`;

  let state = null; // { url, original: DocumentFragment, rewritten: HTMLElement | null, showing: 'original' | 'rewritten' }
  let running = false;
  let button = null;

  // ---------- LLM ----------

  async function createBaseSession(onProgress) {
    if (typeof LanguageModel === 'undefined') {
      throw new Error(
        'このブラウザでは内蔵の LLM（Prompt API）が使えません。Edge Canary / Dev で edge://flags の「Prompt API for Phi mini」を有効にしてください。'
      );
    }
    const options = {
      initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
      expectedInputs: [{ type: 'text', languages: ['ja'] }],
      expectedOutputs: [{ type: 'text', languages: ['ja'] }],
    };
    const availability = await LanguageModel.availability(options).catch(() => LanguageModel.availability());
    if (availability === 'unavailable') {
      throw new Error('この端末では内蔵の LLM が使えません（端末の性能の条件を満たしていない可能性があります）。');
    }
    const monitor = (m) => {
      m.addEventListener('downloadprogress', (e) => onProgress(`モデルをダウンロード中… ${Math.round(e.loaded * 100)}%`));
    };
    try {
      return await LanguageModel.create({ ...options, monitor });
    } catch (e) {
      // 言語の指定に対応していない実装向けに、指定なしで作り直す。
      if (e.name === 'NotSupportedError') {
        return await LanguageModel.create({ initialPrompts: options.initialPrompts, monitor });
      }
      throw e;
    }
  }

  async function ask(baseSession, prompt) {
    // 前の節の会話が文脈を圧迫しないよう、毎回システムプロンプトだけの状態から始める。
    const session = await baseSession.clone();
    try {
      return (await session.prompt(prompt)).trim();
    } finally {
      session.destroy();
    }
  }

  // ---------- 本文の取り出しと分割 ----------

  function extractBlocks(body) {
    const blocks = [];
    for (const el of body.children) {
      if (el.matches('[data-table-of-contents]')) continue;
      const text = el.innerText.replace(/\n{2,}/g, '\n').trim();
      if (!text) continue;
      blocks.push(/^H[1-6]$/.test(el.tagName) ? `【見出し】${text}` : text);
    }
    return blocks;
  }

  function chunkBlocks(blocks, maxChars) {
    const chunks = [];
    let current = '';
    for (const block of blocks) {
      // 長すぎる段落は、文の区切りで割る。
      const pieces = block.length > maxChars ? block.match(new RegExp(`[^。！？]{1,${maxChars}}[。！？]?`, 'g')) : [block];
      for (const piece of pieces) {
        const startsSection = piece.startsWith('【見出し】') && current.length > maxChars / 3;
        if (current && (current.length + piece.length > maxChars || startsSection)) {
          chunks.push(current);
          current = '';
        }
        current += (current ? '\n\n' : '') + piece;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  // ---------- 書き換え ----------

  function sectionPrompt(chunk, index, total) {
    return `次の文章は、ある記事の ${total} 個の部分のうち ${index + 1} 番目です。この部分を、論文の一つの節として書き直してください。

出力の形式（この形式以外は書かない）:
1 行目: 「## 」に続けて、この節の内容を表す短い見出し
2 行目以降: 段落を空行で区切って書く。段落は 2〜5 個。各段落の最初の文はその段落の要点を言い切る文にする。

文章:
"""
${chunk}
"""`;
  }

  function parseSection(text, index) {
    const lines = text.replace(/\r/g, '').split('\n');
    let heading = '';
    const headingIdx = lines.findIndex((l) => /^\s*#{1,4}\s+/.test(l));
    if (headingIdx !== -1) {
      heading = lines[headingIdx].replace(/^\s*#{1,4}\s+/, '').trim();
      lines.splice(headingIdx, 1);
    }
    const paragraphs = lines
      .join('\n')
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\n/g, '').replace(/^\s*[-*・]\s*/, '').replace(/\*\*/g, '').trim())
      .filter(Boolean);
    return { heading: heading || `第 ${index + 1} 節`, paragraphs };
  }

  function firstSentence(paragraph) {
    const m = paragraph.match(/^.*?[。！？]/);
    return m ? m[0] : paragraph;
  }

  function frontMatterPrompt(sections, maxChars) {
    let outline = sections
      .map((s, i) => `${i + 1}. ${s.heading}\n${s.paragraphs.map(firstSentence).join('\n')}`)
      .join('\n\n');
    if (outline.length > maxChars) outline = outline.slice(0, maxChars);
    return `次は、ある論文の各節の見出しと、各段落の最初の文です。これを読んで、論文のタイトルと要約を書いてください。

出力の形式（この形式以外は書かない）:
タイトル: 内容を具体的に表すタイトルを 1 行で
要約: 論文全体の目的・主張・結論を 3〜5 文で

各節の見出しと要点:
"""
${outline}
"""`;
  }

  function parseFrontMatter(text, fallbackTitle) {
    const title = text.match(/タイトル[:：]\s*(.+)/)?.[1]?.replace(/^[「『"]|[」』"]$/g, '').trim();
    const abstract = text.match(/要約[:：]\s*([\s\S]+)/)?.[1]?.replace(/\s*\n\s*/g, '').trim();
    return { title: title || fallbackTitle, abstract: abstract || '' };
  }

  async function rewrite(body, onProgress) {
    const blocks = extractBlocks(body);
    if (!blocks.length) throw new Error('本文が見つかりませんでした。');

    onProgress('モデルを準備中…');
    const base = await createBaseSession(onProgress);
    try {
      // 入力と出力が同じくらいの長さになるので、文脈の 1/4 程度を 1 回の入力にする。
      const quota = base.inputQuota || 4096;
      const maxChars = Math.max(600, Math.min(2000, Math.floor(quota / 4)));
      const chunks = chunkBlocks(blocks, maxChars);

      const sections = [];
      for (let i = 0; i < chunks.length; i++) {
        onProgress(`本文を書き換え中… ${i + 1} / ${chunks.length}`);
        sections.push(parseSection(await ask(base, sectionPrompt(chunks[i], i, chunks.length)), i));
      }

      onProgress('タイトルと要約を作成中…');
      const originalTitle = document.querySelector('h1')?.innerText.trim() || '';
      const front = parseFrontMatter(await ask(base, frontMatterPrompt(sections, maxChars * 2)), originalTitle);
      return { ...front, sections };
    } finally {
      base.destroy();
    }
  }

  // ---------- 表示 ----------

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    for (const c of children) node.append(c);
    return node;
  }

  function render({ title, abstract, sections }) {
    const root = el('article', { class: 'nsr-paper' });
    root.append(el('h1', { class: 'nsr-title' }, title));

    if (abstract) {
      root.append(el('section', { class: 'nsr-abstract' }, el('h2', {}, '要約'), el('p', {}, abstract)));
    }

    const toc = el('ol');
    sections.forEach((s, i) => {
      toc.append(el('li', {}, el('a', { href: `#nsr-sec-${i + 1}` }, `${i + 1}. ${s.heading}`)));
    });
    root.append(el('nav', { class: 'nsr-toc', 'aria-label': '目次' }, el('h2', {}, '目次'), toc));

    sections.forEach((s, i) => {
      const sec = el('section', { class: 'nsr-section' }, el('h2', { id: `nsr-sec-${i + 1}` }, `${i + 1}. ${s.heading}`));
      for (const p of s.paragraphs) sec.append(el('p', {}, p));
      root.append(sec);
    });

    root.append(el('p', { class: 'nsr-note' }, 'この本文は Edge 内蔵の LLM が元の記事から書き換えたものです。誤りを含む場合があります。'));
    return root;
  }

  function show(which) {
    const body = document.querySelector(BODY_SELECTOR);
    if (!body || !state) return;
    if (which === 'rewritten' && state.showing === 'original') {
      state.original = document.createDocumentFragment();
      state.original.append(...body.childNodes);
      body.append(state.rewritten);
    } else if (which === 'original' && state.showing === 'rewritten') {
      state.rewritten.remove();
      body.append(state.original);
    }
    state.showing = which;
    updateButton();
  }

  // ---------- ボタン ----------

  function setLabel(text) {
    if (button) button.textContent = text;
  }

  function updateButton() {
    if (running) return;
    if (state?.showing === 'rewritten') setLabel('元の記事に戻す');
    else if (state?.rewritten) setLabel('論文風の表示に切り替える');
    else setLabel('論文風に書き換える');
  }

  async function onClick() {
    if (running) return;
    if (state?.rewritten) {
      show(state.showing === 'rewritten' ? 'original' : 'rewritten');
      return;
    }
    const body = document.querySelector(BODY_SELECTOR);
    if (!body) {
      alertInline('本文が見つかりませんでした。');
      return;
    }
    running = true;
    button.disabled = true;
    try {
      const result = await rewrite(body, setLabel);
      state = { url: location.href, original: null, rewritten: render(result), showing: 'original' };
      running = false;
      show('rewritten');
      body.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      console.error('[note-summarizer]', e);
      alertInline(e.message || String(e));
    } finally {
      running = false;
      button.disabled = false;
      updateButton();
    }
  }

  function alertInline(message) {
    const toast = el('div', { class: 'nsr-toast', role: 'alert' }, message);
    document.body.append(toast);
    setTimeout(() => toast.remove(), 8000);
  }

  function sync() {
    const isArticle = ARTICLE_PATH.test(location.pathname);
    if (state && state.url !== location.href) state = null; // note は SPA なので、記事を移ったら状態を捨てる。
    if (isArticle && !button) {
      button = el('button', { class: 'nsr-button', type: 'button' });
      button.addEventListener('click', onClick);
      document.body.append(button);
    } else if (!isArticle && button && !running) {
      button.remove();
      button = null;
    }
    updateButton();
  }

  let lastUrl = '';
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      sync();
    }
  }, 1000);
  sync();
})();
