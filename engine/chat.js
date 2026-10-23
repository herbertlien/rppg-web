// 對話式問卷的介面：一題一個泡泡，按鈕作答。預覽頁與正式問卷頁共用。

export const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export function makeChat(box) {
  const say = (cls, text) => {
    const b = el('div', cls, text);
    box.append(b);
    b.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return b;
  };

  // 問一題，回傳選到的 value 陣列
  const ask = q => new Promise(done => {
    const opts = el('div', 'opts');
    const sel = new Set();
    const go = el('button', 'go', '確定');
    for (const o of q.options) {
      const b = el('button', '', o.label);
      b.onclick = () => {
        if (q.type === 'single') { opts.remove(); go.remove(); return done([o.value]); }
        if (sel.has(o.value)) sel.delete(o.value);
        else {
          // 「都沒有」和其他選項互斥
          if (o.exclusive) sel.clear();
          else for (const x of q.options) if (x.exclusive) sel.delete(x.value);
          if (q.max && sel.size >= q.max) return;
          sel.add(o.value);
        }
        [...opts.children].forEach((c, i) => c.classList.toggle('on', sel.has(q.options[i].value)));
        go.disabled = !sel.size;
      };
      opts.append(b);
    }
    box.append(opts);
    if (q.type === 'multi') {
      go.disabled = true;
      go.onclick = () => { opts.remove(); go.remove(); done([...sel]); };
      box.append(go);
    }
    opts.scrollIntoView({ behavior: 'smooth', block: 'end' });
  });

  // 依序問完全部題目；遇到拒收選項就停。回傳 { answers, reject }
  const run = async (questions, rejectMessages) => {
    const answers = {};
    for (const q of questions.questions) {
      say('bot', q.text);
      const picked = await ask(q);
      answers[q.id] = q.type === 'multi' ? picked : picked[0];
      say('me', picked.map(v => q.options.find(o => o.value === v).label).join('、'));
      const rej = picked.map(v => q.options.find(o => o.value === v)).find(o => o.reject);
      if (rej) { say('bot', rejectMessages[rej.reject]); return { answers, reject: rej.reject }; }
    }
    return { answers, reject: null };
  };

  return { say, ask, run };
}
