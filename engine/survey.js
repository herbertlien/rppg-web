// 一次一題的問卷介面。預覽頁與正式問卷頁共用。
// 單選題點了就跳下一題；複選題按底部的「下一題」；隨時可回上一題；最後有總覽可修改再送出。
// 沿用本檔的版本號載入引擎，確保兩者同一版
const { isShown } = await import('./engine.js' + new URL(import.meta.url).search);

export const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const ADVANCE_MS = 180;   // 點選後留一下讓人看到選到哪個

// root：放問卷的容器。回傳 Promise，送出時 resolve 答案（只含有問到的題目）。
export function runSurvey(root, questions, rejectMessages, { intro, submitLabel = '送出' } = {}) {
  const qs = questions.questions;
  const answers = {};
  const history = [];       // 走過的題目索引，給「上一題」用
  let reviewing = false;    // 從總覽點進來修改時，答完回總覽

  return new Promise(resolve => {
    const shownList = () => qs.filter(q => isShown(q, answers));
    const nextIndex = from => {
      for (let i = from + 1; i < qs.length; i++) if (isShown(qs[i], answers)) return i;
      return -1;
    };
    // 只保留目前會問到的題目的答案（例如改成男性後，懷孕題的答案要拿掉）
    const finalAnswers = () => Object.fromEntries(shownList().filter(q => q.id in answers).map(q => [q.id, answers[q.id]]));

    function screen(children, bottom) {
      root.replaceChildren();
      const s = el('div', 'screen');
      s.append(...children);
      root.append(s);
      if (bottom) root.append(bottom);
      window.scrollTo(0, 0);
    }

    function header(i) {
      const list = shownList();
      const n = list.indexOf(qs[i]) + 1;
      const h = el('div', 'top');
      const back = el('button', 'back', '‹ 上一題');
      back.hidden = !history.length && !reviewing;
      back.onclick = () => (reviewing ? summary() : show(history.pop()));
      const bar = el('div', 'bar');
      const fill = el('div');
      fill.style.width = `${Math.round((n / list.length) * 100)}%`;
      bar.append(fill);
      h.append(back, el('span', 'count', `${n} / ${list.length}`), bar);
      return h;
    }

    function show(i) {
      const q = qs[i];
      const multi = q.type === 'multi';
      const sel = new Set(multi ? answers[q.id] || [] : answers[q.id] != null ? [answers[q.id]] : []);
      const opts = el('div', 'choices');
      const next = el('button', 'go', reviewing ? '回總覽' : '下一題');
      const bottom = el('div', 'dock');
      bottom.append(next);

      const done = () => {
        answers[q.id] = multi ? q.options.map(o => o.value).filter(v => sel.has(v)) : [...sel][0];
        const o = q.options.find(x => sel.has(x.value) && x.reject);
        if (o) return rejected(i, o.reject);
        if (reviewing) return summary();
        history.push(i);
        const j = nextIndex(i);
        j < 0 ? summary() : show(j);
      };
      const paint = () => {
        [...opts.children].forEach((b, k) => b.classList.toggle('on', sel.has(q.options[k].value)));
        next.disabled = !sel.size;
      };

      q.options.forEach(o => {
        const b = el('button', multi ? 'choice multi' : 'choice', o.label);
        b.onclick = () => {
          if (!multi || o.exclusive) {
            sel.clear();
            sel.add(o.value);
            paint();
            opts.classList.add('locked');
            return setTimeout(done, ADVANCE_MS);
          }
          if (sel.has(o.value)) sel.delete(o.value);
          else {
            for (const x of q.options) if (x.exclusive) sel.delete(x.value);
            if (q.max && sel.size >= q.max) return;
            sel.add(o.value);
          }
          paint();
        };
        opts.append(b);
      });
      next.onclick = done;
      paint();

      const ask = el('div', 'ask');
      ask.append(el('div', 'who', 'Deerly'), el('div', 'qtext', q.text));
      // 單選題不需要按鈕；從總覽進來時保留「回總覽」
      screen([header(i), ask, opts], multi || reviewing ? bottom : null);
    }

    function rejected(i, code) {
      const back = el('button', 'go ghost', '我選錯了，回上一題');
      back.onclick = () => show(i);
      const box = el('div', 'ask');
      box.append(el('div', 'who', 'Deerly'), el('div', 'qtext', rejectMessages[code]));
      const dock = el('div', 'dock');
      dock.append(back);
      screen([box], dock);
    }

    function summary() {
      reviewing = true;
      // 修改後多出來、還沒回答的題目（例如性別改成女性後的懷孕題），先補答
      const missing = shownList().find(q => !(q.id in answers));
      if (missing) return show(qs.indexOf(missing));
      const list = el('div', 'summary');
      for (const q of shownList()) {
        const v = answers[q.id];
        const labels = (Array.isArray(v) ? v : [v]).map(x => q.options.find(o => o.value === x)?.label ?? '');
        const row = el('button', 'srow');
        row.append(el('span', 'sq', q.short || q.text), el('span', 'sa', labels.join('、')));
        row.onclick = () => show(qs.indexOf(q));
        list.append(row);
      }
      const go = el('button', 'go', submitLabel);
      go.onclick = () => { go.disabled = true; resolve(finalAnswers()); };
      const dock = el('div', 'dock');
      dock.append(go);
      const ask = el('div', 'ask');
      ask.append(el('div', 'who', 'Deerly'), el('div', 'qtext', '確認一下你的回答，點任何一行可以修改。'));
      screen([ask, list], dock);
    }

    if (intro) {
      const start = el('button', 'go', '開始');
      start.onclick = () => show(nextIndex(-1));
      const box = el('div', 'ask');
      box.append(el('div', 'who', 'Deerly'), el('div', 'qtext', intro));
      const dock = el('div', 'dock');
      dock.append(start);
      screen([box], dock);
    } else {
      show(nextIndex(-1));
    }
  });
}
