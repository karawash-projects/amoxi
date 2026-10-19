/**
 * Minimal, safe rendering of assistant text: paragraphs, "- " bullet lists and **bold**.
 * Builds elements (never innerHTML), so model output can't inject markup.
 */
function inline(text: string): unknown[] {
  const out: unknown[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<strong>{m[1]}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderRichText(text: string): unknown[] {
  const blocks: unknown[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length) blocks.push(<p>{para.flatMap((line, i) => (i === 0 ? inline(line) : [<br />, ...inline(line)]))}</p>);
    para = [];
  };
  const flushList = (): void => {
    if (list.length) blocks.push(<ul>{list.map((l) => <li>{inline(l)}</li>)}</ul>);
    list = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      list.push(bullet[1]);
    } else if (line.trim() === '') {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return blocks;
}
