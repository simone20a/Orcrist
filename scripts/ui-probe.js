// Probe 5: the approval gate, the hover preview, and deleting a session.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
require('./electron/main.js');

const errors = [];
const js = (w, code) => w.webContents.executeJavaScript(code);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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


// Activate like a real pointer does: mousedown, mouseup, then click. Calling
// .click() alone skipped mousedown, which is exactly the event the context
// menu was closing on — so the probe passed while the menu was unusable.
async function press(w, selectorJs) {
  return js(
    w,
    `(() => {
       const el = ${selectorJs};
       if (!el) return 'not found';
       for (const type of ['mousedown', 'mouseup', 'click']) {
         el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
       }
       return true;
     })()`,
  );
}

app.whenReady().then(() => {
  setTimeout(async () => {
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.on('console-message', (_e, lvl, msg) => {
      if (lvl >= 2) errors.push(msg);
    });
    const out = {};
    try {
      await js(
        w,
        `(async () => {
          localStorage.removeItem('orcrist.drawerOpen');
          const s = await window.orcrist.settings.load();
          s.providers.anthropic.apiKey = 'k';
          s.providers.anthropic.baseUrl = 'http://127.0.0.1:8897';
          s.authoring = { provider: 'anthropic', model: 'mock' };
          s.execution = { provider: 'anthropic', model: 'mock' };
          s.requireModelApproval = true;
          await window.orcrist.settings.save(s);
          for (const old of await window.orcrist.projects.list()) await window.orcrist.projects.forget(old.id);
          await window.orcrist.projects.create('Approval probe', '/tmp/probe-ws4');
        })()`,
      );
      w.webContents.reload();
      await wait(2500);
      await js(w, `document.querySelectorAll('.project-card:not(.new)')[0].click(); true;`);
      await wait(1200);

      // --- 1. the approval dialog appears and the run is paused ----------
      await type(w, 'Check that the toolchain works.');
      out.dialogAppeared = await until(w, `!!document.querySelector('.pv-box')`);
      await wait(500);
      out.dialogTitle = await js(w, `document.querySelector('.modal-head h2')?.textContent`);
      out.runStatusWhileWaiting = await js(
        w,
        `(async () => {
           const ps = await window.orcrist.projects.list();
           const ss = await window.orcrist.sessions.list(ps[0].id);
           const rs = await window.orcrist.runs.list(ps[0].id, ss[0].id);
           return rs[rs.length - 1].status;
         })()`,
      );
      out.sessionMachineBeforeApproval = await js(
        w,
        `(async () => {
           const ps = await window.orcrist.projects.list();
           const ss = await window.orcrist.sessions.list(ps[0].id);
           return ss[0].machine ? ss[0].machine.name : null;
         })()`,
      );
      out.stateBoxes = await js(w, `document.querySelectorAll('.pv-box').length`);
      fs.writeFileSync('/tmp/shot-approval.png', (await w.capturePage()).toPNG());

      // --- 2. hovering a state shows its prompt --------------------------
      out.cardBeforeHover = await js(w, `!!document.querySelector('.pv-tip')`);
      await js(
        w,
        `(() => {
           const nodes = [...document.querySelectorAll('.pv-box')];
           const check = nodes.find(n => n.textContent.includes('Check')) || nodes[0];
           check.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
           check.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
           return true;
         })()`,
      );
      await wait(600);
      out.hoverCard = await js(
        w,
        `(() => {
           const c = document.querySelector('.pv-tip');
           if (!c) return null;
           return {
             state: c.querySelector('.mono')?.textContent,
             prompt: c.querySelector('.pv-tip-body')?.textContent,
             kv: [...c.querySelectorAll('.kv dt, .kv dd')].map(e => e.textContent),
           };
         })()`,
      );
      fs.writeFileSync('/tmp/shot-approval-hover.png', (await w.capturePage()).toPNG());

      // --- 3. approving lets it run --------------------------------------
      await js(
        w,
        `[...document.querySelectorAll('.modal-foot button')].find(b => b.textContent.includes('Approve')).click(); true;`,
      );
      await until(w, `!document.querySelector('.main-head button.danger')`, 60);
      await wait(800);
      out.afterApprove = await js(
        w,
        `({
           final: document.querySelector('.ev.final')?.textContent,
           approvalNotes: [...document.querySelectorAll('.ev.status .ev-text')].map(e => e.textContent).filter(t => /approv|Approv/.test(t)),
         })`,
      );
      out.sessionMachineAfterApproval = await js(
        w,
        `(async () => {
           const ps = await window.orcrist.projects.list();
           const ss = await window.orcrist.sessions.list(ps[0].id);
           return ss[0].machine ? ss[0].machine.name : null;
         })()`,
      );

      // --- 4. discarding a revision leaves the session alone --------------
      await type(w, 'Add a review step after the check.');
      await until(w, `!!document.querySelector('.pv-box')`);
      await wait(400);
      out.revisedTitle = await js(w, `document.querySelector('.modal-head h2')?.textContent`);
      out.revisedStateBoxes = await js(w, `document.querySelectorAll('.pv-box').length`);
      await js(
        w,
        `[...document.querySelectorAll('.modal-foot button')].find(b => b.textContent.includes('Discard')).click(); true;`,
      );
      await wait(1500);
      out.afterDiscard = await js(
        w,
        `(async () => {
           const ps = await window.orcrist.projects.list();
           const ss = await window.orcrist.sessions.list(ps[0].id);
           const rs = await window.orcrist.runs.list(ps[0].id, ss[0].id);
           return {
             lastRunStatus: rs[rs.length - 1].status,
             sessionMachine: ss[0].machine ? ss[0].machine.name : null,
             sessionStates: ss[0].machine ? ss[0].machine.states.length : 0,
             dialogGone: !document.querySelector('.pv-box'),
           };
         })()`,
      );
      fs.writeFileSync('/tmp/shot-discarded.png', (await w.capturePage()).toPNG());

      // --- 5. deleting a session ------------------------------------------
      await js(w, `document.querySelector('.rail-head button.icon').click(); true;`);
      await wait(900);
      out.sessionsBeforeDelete = await js(w, `document.querySelectorAll('.session-item').length`);
      out.noTrashIcons = await js(w, `document.querySelectorAll('.session-item button').length === 0`);

      // rename through the right-click menu
      await js(
        w,
        `(() => {
           const item = [...document.querySelectorAll('.session-item')].pop();
           const r = item.getBoundingClientRect();
           item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 }));
           return true;
         })()`,
      );
      await wait(500);
      out.menuItems = await js(w, `[...document.querySelectorAll('.ctx-item')].map(b => b.textContent)`);
      out.renameClick = await press(w, `[...document.querySelectorAll('.ctx-item')].find(b => b.textContent === 'Rename')`);
      await wait(400);
      await js(
        w,
        `(() => {
           const inp = document.querySelector('.session-item .rename');
           const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
           setter.call(inp, 'Renamed by probe');
           inp.dispatchEvent(new Event('input', { bubbles: true }));
           inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
           return true;
         })()`,
      );
      await wait(900);
      out.renamed = await js(
        w,
        `[...document.querySelectorAll('.session-item .t')].map(e => e.textContent).includes('Renamed by probe')`,
      );
      out.renamePersisted = await js(
        w,
        `(async () => {
           const ps = await window.orcrist.projects.list();
           const ss = await window.orcrist.sessions.list(ps[0].id);
           return ss.some(s => s.title === 'Renamed by probe');
         })()`,
      );

      // delete through the same menu
      await js(
        w,
        `(() => {
           const item = [...document.querySelectorAll('.session-item')].pop();
           const r = item.getBoundingClientRect();
           item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 }));
           return true;
         })()`,
      );
      await wait(500);
      out.deleteClick = await press(w, `[...document.querySelectorAll('.ctx-item')].find(b => b.textContent === 'Delete')`);
      await wait(600);
      out.deleteConfirm = await js(w, `document.querySelector('.modal-head h2')?.textContent`);
      fs.writeFileSync('/tmp/shot-delete.png', (await w.capturePage()).toPNG());
      await js(
        w,
        `[...document.querySelectorAll('.modal-foot button')].find(b => b.className.includes('danger')).click(); true;`,
      );
      await wait(1200);
      out.sessionsAfterDelete = await js(w, `document.querySelectorAll('.session-item').length`);

      // deleting the only remaining session should still work
      await js(
        w,
        `(() => {
           const item = document.querySelector('.session-item');
           const r = item.getBoundingClientRect();
           item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 }));
           return true;
         })()`,
      );
      await wait(400);
      await press(w, `[...document.querySelectorAll('.ctx-item')].find(b => b.textContent === 'Delete')`);
      await wait(500);
      const hasConfirm = await js(w, `!!document.querySelector('.modal-foot button.danger')`);
      if (hasConfirm) {
        await js(w, `document.querySelector('.modal-foot button.danger').click(); true;`);
        await wait(1200);
      }
      out.lastSessionDeletable = hasConfirm;
      out.sessionsAtEnd = await js(w, `document.querySelectorAll('.session-item').length`);

      console.log('PROBE5 ' + JSON.stringify(out, null, 2));
      console.log('PROBE5 console errors:', errors.length ? errors.join(' / ') : 'none');
    } catch (e) {
      console.log('PROBE5 FAILED:', e.message, '\n', JSON.stringify(out, null, 2));
    }
    app.quit();
  }, 3000);
});
