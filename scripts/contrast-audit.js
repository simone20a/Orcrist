// Probe 7: measure the contrast of every piece of rendered text on every
// screen, HTML and SVG alike, against WCAG AA (4.5:1, or 3:1 for large text).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
require('./electron/main.js');

const js = (w, code) => w.webContents.executeJavaScript(code);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (w, n) => fs.writeFileSync(`/tmp/ui-${n}.png`, (await w.capturePage()).toPNG());

async function until(w, expr, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await js(w, expr)) return true;
    await wait(400);
  }
  return false;
}

async function type(w, text) {
  await js(
    w,
    `(() => {
       const ta = document.querySelector('.composer textarea');
       const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
       setter.call(ta, ${JSON.stringify(text)});
       ta.dispatchEvent(new Event('input', { bubbles: true }));
       document.querySelector('.composer button.send').click();
       return true;
     })()`,
  );
}

const AUDIT = `(() => {
  // Chromium serialises color-mix() as color(srgb r g b / a) with 0..1
  // components, and rgb() with 0..255. Reading one as the other makes every
  // mixed colour look like black, which is exactly the kind of false alarm an
  // audit must not produce.
  const parse = (c) => {
    if (!c) return null;
    const m = c.match(/[\\d.]+(?:e[-+]?\\d+)?/g);
    if (!m) return null;
    const n = m.map(Number);
    if (/^color\\(/.test(c)) {
      const rgb = n.slice(0, 3).map((v) => Math.max(0, Math.min(255, v * 255)));
      return n.length > 3 ? [...rgb, n[3]] : rgb;
    }
    return n;
  };
  const lum = ([r, g, b]) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const over = (fg, a, bg) => [0, 1, 2].map((i) => a * fg[i] + (1 - a) * bg[i]);

  // walk up for the first ancestor that actually paints something opaque
  const bgOf = (el) => {
    let e = el;
    const stack = [];
    while (e) {
      const cs = getComputedStyle(e);
      const c = parse(cs.backgroundColor);
      if (c) {
        const a = c.length > 3 ? c[3] : 1;
        if (a >= 0.999) {
          let acc = [c[0], c[1], c[2]];
          while (stack.length) { const s = stack.pop(); acc = over(s.c, s.a, acc); }
          return acc;
        }
        if (a > 0) stack.push({ c: [c[0], c[1], c[2]], a });
      }
      e = e.parentElement;
    }
    let acc = [255, 255, 255];
    while (stack.length) { const s = stack.pop(); acc = over(s.c, s.a, acc); }
    return acc;
  };

  const results = [];
  const seen = new Set();

  const check = (el, fgStr, label) => {
    const fg = parse(fgStr);
    if (!fg) return;
    const a = fg.length > 3 ? fg[3] : 1;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return;

    const bg = bgOf(el);
    const eff = over([fg[0], fg[1], fg[2]], a, bg);
    const l1 = lum(eff), l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(cs.fontSize) || 12;
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 46);
    if (!text) return;
    const key = label + '|' + text + '|' + Math.round(ratio * 100);
    if (seen.has(key)) return;
    seen.add(key);
    if (ratio < need) {
      results.push({
        where: label,
        text,
        cls: (el.getAttribute('class') || '').slice(0, 46),
        px: +size.toFixed(1),
        weight,
        ratio: +ratio.toFixed(2),
        need,
        fg: fgStr,
        bg: 'rgb(' + bg.map(Math.round).join(',') + ')',
      });
    }
  };

  // HTML: only elements that own a text node, so we measure the element that
  // actually sets the colour rather than every ancestor that contains text
  document.querySelectorAll('body *').forEach((el) => {
    if (el instanceof SVGElement) return;
    const owns = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!owns) return;
    check(el, getComputedStyle(el).color, 'html');
  });

  // SVG text paints with fill, not color — and its background is usually a
  // SIBLING shape inside the same <g>, not an ancestor, so walking parents
  // finds the canvas and reports a false failure for every label sitting on a
  // filled node. Look for the sibling whose box actually covers the text.
  const svgBgOf = (el) => {
    const tb = el.getBoundingClientRect();
    const g = el.parentElement;
    if (g) {
      for (const sib of g.children) {
        if (sib === el || !(sib instanceof SVGGraphicsElement)) continue;
        if (!/^(rect|circle|ellipse|path|polygon)$/.test(sib.tagName)) continue;
        const f = parse(getComputedStyle(sib).fill);
        if (!f) continue;
        const fo = parseFloat(getComputedStyle(sib).fillOpacity || '1');
        if (fo < 0.999) continue;
        const sb = sib.getBoundingClientRect();
        const covers =
          tb.left >= sb.left - 1 && tb.right <= sb.right + 1 &&
          tb.top >= sb.top - 1 && tb.bottom <= sb.bottom + 1;
        if (covers) return [f[0], f[1], f[2]];
      }
    }
    return bgOf(el);
  };

  document.querySelectorAll('svg text, svg tspan').forEach((el) => {
    const fgStr = getComputedStyle(el).fill;
    const fg = parse(fgStr);
    if (!fg) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || +cs.opacity === 0) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return;
    const bg = svgBgOf(el);
    const a = fg.length > 3 ? fg[3] : 1;
    const eff = over([fg[0], fg[1], fg[2]], a, bg);
    const l1 = lum(eff), l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(cs.fontSize) || 12;
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    const text = (el.textContent || '').trim().slice(0, 46);
    if (!text) return;
    const key = 'svg|' + text + '|' + Math.round(ratio * 100);
    if (seen.has(key)) return;
    seen.add(key);
    if (ratio < need) {
      results.push({ where: 'svg', text, cls: (el.getAttribute('class') || '').slice(0, 46),
        px: +size.toFixed(1), weight, ratio: +ratio.toFixed(2), need, fg: fgStr,
        bg: 'rgb(' + bg.map(Math.round).join(',') + ')' });
    }
  });

  // placeholders are not text nodes; measure the declared colour by hand
  document.querySelectorAll('input, textarea').forEach((el) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--ink-3)';
    el.parentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    if (el.placeholder) {
      const holder = document.createElement('span');
      holder.textContent = el.placeholder;
      holder.style.cssText = 'position:absolute;left:-9999px;font-size:' + getComputedStyle(el).fontSize;
      el.parentElement.appendChild(holder);
      const fake = { getBoundingClientRect: () => el.getBoundingClientRect(), parentElement: el.parentElement };
      holder.remove();
      // measure against the input's own background
      const bg = bgOf(el);
      const fg = parse(c);
      const a = fg.length > 3 ? fg[3] : 1;
      const eff = over([fg[0], fg[1], fg[2]], a, bg);
      const ratio = (Math.max(lum(eff), lum(bg)) + 0.05) / (Math.min(lum(eff), lum(bg)) + 0.05);
      if (ratio < 4.5) {
        results.push({ where: 'placeholder', text: el.placeholder.slice(0, 46), cls: el.className,
          px: parseFloat(getComputedStyle(el).fontSize), weight: 400, ratio: +ratio.toFixed(2), need: 4.5,
          fg: c, bg: 'rgb(' + bg.map(Math.round).join(',') + ')' });
      }
    }
  });

  return results;
})()`;

app.whenReady().then(() => {
  setTimeout(async () => {
    const w = BrowserWindow.getAllWindows()[0];
    const all = [];
    const consoleErrors = [];
    w.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) consoleErrors.push(msg); });

    const sweep = async (name) => {
      const r = await js(w, AUDIT);
      r.forEach((x) => all.push({ screen: name, ...x }));
      await shot(w, name);
    };

    try {
      await js(
        w,
        `(async () => {
          localStorage.removeItem('orcrist.drawerOpen');
          const s = await window.orcrist.settings.load();
          s.providers.anthropic.apiKey = 'k';
          s.providers.anthropic.baseUrl = 'http://127.0.0.1:8897';
          s.authoring = { provider: 'anthropic', model: 'gpt-5.1' };
          s.execution = { provider: 'anthropic', model: 'gpt-5.1' };
          s.requireModelApproval = true;
          await window.orcrist.settings.save(s);
          for (const old of await window.orcrist.projects.list()) await window.orcrist.projects.forget(old.id);
          await window.orcrist.projects.create('Orcrist compiler', '/tmp/probe-ws5');
          await window.orcrist.projects.create('Token flow analyser', '/tmp/probe-ws6');
          await window.orcrist.projects.create('Thesis experiments', '/tmp/probe-ws7');
        })()`,
      );
      w.webContents.reload();
      await wait(2600);
      await sweep('1-projects');

      await js(w, `document.querySelector('.project-card.new').click(); true;`);
      await wait(700);
      await sweep('1b-new-project');
      await js(w, `[...document.querySelectorAll('.modal-foot button')].find(b => b.textContent === 'Cancel').click(); true;`);
      await wait(400);

      await js(w, `document.querySelectorAll('.project-card:not(.new)')[0].click(); true;`);
      await wait(1300);
      await sweep('2-empty-session');

      await type(w, 'Check that the toolchain works and report anything broken.');
      await until(w, `!!document.querySelector('.pv-box')`);
      await wait(700);
      await sweep('3-approval');

      await js(
        w,
        `(() => {
           const nodes = [...document.querySelectorAll('.pv-box')];
           const n = nodes.find(x => x.parentElement.textContent.includes('Check')) || nodes[0];
           n.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
           return true;
         })()`,
      );
      await wait(600);
      await sweep('4-approval-hover');

      await js(w, `[...document.querySelectorAll('.modal-foot button')].find(b => b.textContent.includes('Approve')).click(); true;`);
      await until(w, `!document.querySelector('.main-head button.danger')`, 60);
      await wait(900);
      await sweep('5-transcript');
      await js(w, `document.querySelector('.log').scrollTop = 0; true;`);
      await wait(500);
      await sweep('5c-top');

      // open a tool block so its body is measured too
      await js(w, `document.querySelector('.tool-head')?.click(); true;`);
      await wait(400);
      await sweep('5b-tool-open');

      await js(w, `document.querySelector('.titlebar button.icon[aria-pressed]').click(); true;`);
      await wait(800);
      await sweep('6-drawer');

      // the right-click menu is new UI and floats on its own ground — measure it
      await js(
        w,
        `(() => {
           const item = document.querySelector('.session-item');
           const r = item.getBoundingClientRect();
           item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 30, clientY: r.top + 12 }));
           return true;
         })()`,
      );
      await wait(500);
      await sweep('6b-context-menu');
      await js(w, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true;`);
      await wait(300);

      await js(w, `[...document.querySelectorAll('.titlebar button.icon')].pop().click(); true;`);
      await wait(700);
      await sweep('7-settings');
      for (const t of ['Providers', 'Tools & limits']) {
        await js(w, `[...document.querySelectorAll('.tab')].find(b => b.textContent.includes(${JSON.stringify(t.split(' ')[0])})).click(); true;`);
        await wait(500);
        await sweep('7-settings-' + t.split(' ')[0].toLowerCase());
      }

      console.log('AUDIT ' + JSON.stringify(all, null, 2));
      console.log('AUDIT failures: ' + all.length);
      console.log('AUDIT console errors: ' + (consoleErrors.length ? consoleErrors.join(' / ') : 'none'));
    } catch (e) {
      console.log('PROBE7 FAILED:', e.message);
      console.log('AUDIT partial ' + JSON.stringify(all, null, 2));
    }
    app.quit();
  }, 3000);
});
