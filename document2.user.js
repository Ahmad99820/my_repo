// ==UserScript==
// @name         BI Publisher - Bulk Report HTML Download by Account
// @namespace    local.bip.bulkexport
// @version      2.2
// @description  Loops over a list of accounts, sets branch / dates / GL code, applies the report and downloads the rendered report as an .html file
// @match        *://*/xmlpserver/*
// @include      /^https?:\/\/[^\/]*\/xmlpserver\/.*$/
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* =====================  CONFIG (edit here)  ===================== */
  const CONFIG = {
    ACCOUNTS: [
      // '008AKTF00007822',   // example account from your notes (uncomment if needed)
      '006AKTF00530899',
      '132AKTF00000556',
      '026AKTF00002265',
      '006AKTF00513900',
      '433AKTF00000061',
      '031AKTF00001444',
      '983AKTF00000857',
      '026AKTF00002308',
    ],

    FROM_DATE: '01-01-2026',   // MM-dd-yyyy (1 Jan 2026). "To date" is always today.
    GL_CODE: '40901024',       // placeholder / default GL code

    LOADING_IFRAME_ID: 'xdo:loadingParameters_xdoFDIframe',
    LOADING_DIALOG_ID: 'xdo:loadingParameters',
    REPORT_FRAME_ID: 'xdo:docframe0',

    REPORT_LOAD_TIMEOUT_MS: 90000, // max wait for the report to render after Apply
    REPORT_SETTLE_MS: 1500,        // pause after the report frame has loaded
    SAVE_MODE: 'report',           // 'report' = the rendered report (iframe) | 'page' = whole outer page | 'both'
    DOWNLOAD_SETTLE_MS: 1500,      // pause after each download, before the next account
    STEP_TIMEOUT_MS: 15000,        // max wait for an element to appear
    LOADING_TIMEOUT_MS: 120000,    // max wait for "Loading parameters..." to finish
  };
  /* ================================================================ */

  let stopRequested = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const byId = (id) => document.getElementById(id);
  const norm = (s) => String(s == null ? '' : s).trim().replace(/^0+/, '');

  // Really visible: not display:none / visibility:hidden, has size, on screen.
  function isShown(el) {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0;
  }

  function todayMDY() {
    const d = new Date();
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${d.getFullYear()}`;
  }

  async function waitFor(fn, timeout = CONFIG.STEP_TIMEOUT_MS, interval = 100, what = 'element') {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (stopRequested) throw new Error('Stopped by user');
      let v;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      await sleep(interval);
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  // Like waitFor but returns true/false instead of throwing on timeout.
  async function tryWait(fn, timeout, interval = 100) {
    try { await waitFor(fn, timeout, interval); return true; }
    catch (e) { if (stopRequested) throw e; return false; }
  }

  const nativeClick = (el) => el.click();

  function realClick(el) {
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    ['mouseover', 'mouseenter', 'mousemove', 'mousedown', 'mouseup', 'click'].forEach((type) =>
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
    );
  }

  function hover(el) {
    ['mouseover', 'mouseenter', 'mousemove'].forEach((type) =>
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
    );
  }

  function setValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'End' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Tags errors with the step name so you can see exactly where it failed.
  async function step(name, fn) {
    try { return await fn(); }
    catch (e) {
      if (!stopRequested && !String(e.message).startsWith('[')) e.message = `[${name}] ${e.message}`;
      throw e;
    }
  }

  /* ---------------- "Loading parameters..." handling ---------------- */
  const loadingActive = () =>
    !!byId(CONFIG.LOADING_IFRAME_ID) || isShown(byId(CONFIG.LOADING_DIALOG_ID));

  async function waitForLoading(appearTimeout = 2500) {
    const appeared = await tryWait(loadingActive, appearTimeout, 50);
    if (!appeared) return false;
    await waitFor(() => !loadingActive(), CONFIG.LOADING_TIMEOUT_MS, 100, 'the loading overlay to disappear');
    await sleep(400);
    return true;
  }

  /* ---------------- multi-choice box + search dialog ---------------- */
  function refs(P) {
    const base = `xdo:xdo:_params${P}_div_input`;
    return {
      base,
      input: () => byId(base),
      select: () => byId(`xdo:_params${P}`),
      box: () => byId(`xdo:xdo:_params${P}_div_b`),       // the dropdown list
      link: () => byId(`xdo:xdo:_params${P}_div_s`),      // the "Search ..." link
      dlg: () => byId(`${base}_searchDialog`),
      sInput: () => byId(`${base}_searchDialog_input`),
      sBtn: () => byId(`${base}_searchDialog_button`),
      results: () => byId(`${base}_searchDialog_searchResults`),
    };
  }

  async function openSearchDialog(P) {
    const q = refs(P);
    // The dialog is created lazily by the page on the first "Search ..." click, so it may not exist yet.
    const dialogOpen = () => {
      const d = q.dlg();
      return !!d && getComputedStyle(d).display !== 'none' && !!q.sInput();
    };
    if (dialogOpen()) return;

    const arrow = () => {
      const c = q.input() && q.input().parentElement;
      return (c && c.querySelector('.mchoiceboxDropdownArrow')) || q.input();
    };
    // NOTE: the <a> link itself is made of floated spans, so it measures 0x0 -> never test its visibility;
    // click the inner "Search ..." span (it bubbles up to the link).
    const searchTarget = () => {
      const l = q.link();
      return l ? (l.querySelector('.dialogFloatLeft') || l) : null;
    };

    for (const click of [nativeClick, realClick]) {
      if (!isShown(q.box())) {
        click(arrow());
        await tryWait(() => isShown(q.box()), 1500, 50);
      }
      const t = searchTarget();
      if (t) {
        click(t);
        if (await tryWait(dialogOpen, 3000, 100)) return;
        // some builds bind the handler on the <a> itself
        if (q.link()) {
          click(q.link());
          if (await tryWait(dialogOpen, 2000, 100)) return;
        }
      }
    }

    // Fallback: F12 opens the search dialog from the field
    const inp = q.input();
    inp.focus();
    ['keydown', 'keyup'].forEach((t) =>
      inp.dispatchEvent(new KeyboardEvent(t, { key: 'F12', code: 'F12', keyCode: 123, which: 123, bubbles: true, cancelable: true }))
    );
    if (await tryWait(dialogOpen, 3000, 100)) return;

    const d = q.dlg();
    throw new Error(
      `could not open the search dialog for ${P} ` +
      `(dropdown shown: ${isShown(q.box())}, search link found: ${!!q.link()}, ` +
      `dialog exists: ${!!d}${d ? ', dialog display: ' + getComputedStyle(d).display : ''})`
    );
  }

  async function pickFromSearchDialog(P, code) {
    const q = refs(P);
    await openSearchDialog(P);

    setValue(q.sInput(), code);
    nativeClick(q.sBtn());

    const findItem = () =>
      [...((q.results() && q.results().querySelectorAll('.masterShuttleSelectItem')) || [])]
        .find((e) => isShown(e) && norm(e.getAttribute('value')) === norm(code));

    const first = await waitFor(findItem, 12000, 100, `search result "${code}" for ${P}`);

    // select it (only if it is not already selected, so we never toggle it off)
    for (let i = 0; i < 3; i++) {
      const cur = findItem();
      if (cur && cur.classList.contains('selected')) break;
      realClick(cur || first);
      await sleep(400);
    }

    const ok = q.dlg().querySelector('button[bid="0"]');
    if (!ok) throw new Error(`OK button not found in the ${P} dialog`);
    nativeClick(ok);
    await waitFor(() => !isShown(q.dlg()), 8000, 100, `the ${P} dialog to close`);
    await sleep(300);

    // verify the value really landed
    const sel = q.select();
    const inp = q.input();
    const vals = [inp && inp.value, sel && sel.value, ...(sel ? [...sel.selectedOptions].map((o) => o.value) : [])].filter(Boolean);
    const good = vals.some((v) => String(v).split(/[,;\s]+/).some((t) => norm(t) === norm(code)));
    if (!good) throw new Error(`${P} was not set to ${code} (found: ${vals.join(' | ') || 'nothing'})`);
  }

  /* ---------------- save the rendered report as an .html file ---------------- */
  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 15000);
  }

  // Serialise a document; add <base href> so relative CSS/images still resolve when opened locally.
  function serializeDoc(doc, baseHref) {
    const clone = doc.documentElement.cloneNode(true);
    const head = clone.querySelector('head');
    if (head && !clone.querySelector('base')) {
      const base = doc.createElement('base');
      base.href = baseHref;
      head.insertBefore(base, head.firstChild);
    }
    const dt = doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) : '<!DOCTYPE html>';
    return dt + '\n' + clone.outerHTML;
  }

  async function getReportDoc() {
    const frame = await waitFor(() => byId(CONFIG.REPORT_FRAME_ID), CONFIG.STEP_TIMEOUT_MS, 100, 'the report frame');
    await waitFor(() => {
      try {
        const d = frame.contentDocument;
        const href = frame.contentWindow.location.href;
        return d && d.body && !/transparent/i.test(href) && d.body.innerText.trim().length > 20;
      } catch (e) { return false; } // cross-origin or not ready yet
    }, 30000, 500, 'report content inside the report frame (is the frame readable / did the report render?)');
    return { doc: frame.contentDocument, href: frame.contentWindow.location.href };
  }

  async function saveHtml(account, branch, glCode, fromDate, today) {
    const stem = `${account}_br${branch}_gl${glCode}_${fromDate}_to_${today}`;

    if (CONFIG.SAVE_MODE === 'report' || CONFIG.SAVE_MODE === 'both') {
      const { doc, href } = await getReportDoc();
      downloadText(`${stem}.html`, serializeDoc(doc, href));
      await sleep(CONFIG.DOWNLOAD_SETTLE_MS);
    }
    if (CONFIG.SAVE_MODE === 'page' || CONFIG.SAVE_MODE === 'both') {
      downloadText(`${stem}_page.html`, serializeDoc(document, location.href));
      await sleep(CONFIG.DOWNLOAD_SETTLE_MS);
    }
  }

  /* ---------------- one account ---------------- */
  async function processAccount(account, fromDate, glCode, setStatus) {
    const branch = account.slice(0, 3);
    const today = todayMDY();

    await step('show parameters', async () => {
      if (!isShown(byId('xdo:parameters'))) {
        const l = byId('xdo:reportParamLink');
        if (l) { nativeClick(l); await tryWait(() => isShown(byId('xdo:parameters')), 3000); }
      }
    });

    await step('account number', async () => {
      setStatus('Setting account…');
      const el = await waitFor(() => byId('_paramscustacno'), CONFIG.STEP_TIMEOUT_MS, 100, 'the account input');
      setValue(el, account);
      el.title = account;
      await waitForLoading(2500);
    });

    await step(`branch ${branch}`, async () => {
      setStatus(`Selecting branch ${branch}…`);
      await pickFromSearchDialog('BrCode', branch);
      await waitForLoading(2500);
    });

    await step('dates', async () => {
      setStatus('Setting dates…');
      const d1 = await waitFor(() => byId('_paramsRepDate1'), CONFIG.STEP_TIMEOUT_MS, 100, 'From date input');
      const d2 = await waitFor(() => byId('_paramsRepDate2'), CONFIG.STEP_TIMEOUT_MS, 100, 'To date input');
      setValue(d1, fromDate);
      setValue(d2, today);
      await waitForLoading(1000);
    });

    await step(`GL ${glCode}`, async () => {
      setStatus(`Selecting GL ${glCode}…`);
      await pickFromSearchDialog('GlCode', glCode);
      await waitForLoading(2000);
    });

    await step('apply', async () => {
      setStatus('Applying…');
      // make sure the dates survived any parameter refresh
      const d1 = byId('_paramsRepDate1'), d2 = byId('_paramsRepDate2');
      if (d1.value !== fromDate) setValue(d1, fromDate);
      if (d2.value !== today) setValue(d2, today);

      let loaded = false;
      const onLoad = (e) => { if (e.target && e.target.id === CONFIG.REPORT_FRAME_ID) loaded = true; };
      document.addEventListener('load', onLoad, true); // capture: iframe load doesn't bubble
      try {
        nativeClick(await waitFor(() => byId('reportViewApply'), CONFIG.STEP_TIMEOUT_MS, 100, 'Apply button'));
        await waitForLoading(2000);
        setStatus('Waiting for the report to render…');
        const ok = await tryWait(() => loaded, CONFIG.REPORT_LOAD_TIMEOUT_MS, 200);
        if (!ok) console.warn('[BIP bulk] report frame load not detected, continuing anyway');
      } finally {
        document.removeEventListener('load', onLoad, true);
      }
      await sleep(CONFIG.REPORT_SETTLE_MS);
    });

    await step('save html', async () => {
      setStatus('Saving HTML…');
      await saveHtml(account, branch, glCode, fromDate, today);
    });
  }

  /* ============================  UI  ============================ */
  function buildPanel() {
    if (byId('bip-bulk-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'bip-bulk-panel';
    panel.style.cssText =
      'position:fixed;top:60px;right:12px;width:260px;z-index:2147483647;background:#fff;' +
      'border:1px solid #888;border-radius:6px;padding:8px;font:12px Arial,sans-serif;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.3);color:#000;';
    panel.innerHTML = `
      <div style="font-weight:bold;margin-bottom:6px;">Bulk HTML Download v2.2</div>
      <label>From date (MM-dd-yyyy)<br><input id="bip-from" style="width:100%;box-sizing:border-box"></label><br>
      <label>GL code<br><input id="bip-gl" style="width:100%;box-sizing:border-box"></label><br>
      <label>Accounts (one per line)<br>
        <textarea id="bip-accts" rows="8" style="width:100%;box-sizing:border-box"></textarea></label>
      <div style="margin-top:6px;display:flex;gap:6px;">
        <button id="bip-start" type="button" style="flex:1">Start</button>
        <button id="bip-stop" type="button" style="flex:1" disabled>Stop</button>
      </div>
      <div id="bip-status" style="margin-top:6px;min-height:30px;white-space:pre-wrap;">Idle</div>`;
    document.body.appendChild(panel);

    byId('bip-from').value = CONFIG.FROM_DATE;
    byId('bip-gl').value = CONFIG.GL_CODE;
    byId('bip-accts').value = CONFIG.ACCOUNTS.join('\n');

    const statusEl = byId('bip-status');
    const startBtn = byId('bip-start');
    const stopBtn = byId('bip-stop');
    const setStatus = (t) => { statusEl.textContent = t; console.log('[BIP bulk]', t); };

    stopBtn.onclick = () => { stopRequested = true; setStatus('Stopping…'); };

    startBtn.onclick = async () => {
      const fromDate = byId('bip-from').value.trim();
      const glCode = byId('bip-gl').value.trim();
      const accounts = byId('bip-accts').value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

      stopRequested = false;
      startBtn.disabled = true;
      stopBtn.disabled = false;

      const failed = [];
      let done = 0;
      for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        const prefix = `[${i + 1}/${accounts.length}] ${acc}\n`;
        if (!/^\d{3}/.test(acc)) { failed.push(`${acc} (bad format)`); continue; }
        try {
          await processAccount(acc, fromDate, glCode, (t) => setStatus(prefix + t));
          done++;
        } catch (e) {
          console.error('[BIP bulk] failed for', acc, e);
          if (stopRequested) break;
          failed.push(`${acc} ${e.message}`);
          setStatus(prefix + 'FAILED ' + e.message);
          await sleep(1500);
        }
      }

      setStatus(
        (stopRequested ? 'Stopped. ' : 'Finished. ') +
        `Saved: ${done}/${accounts.length}` +
        (failed.length ? `\nFailed:\n${failed.join('\n')}` : '')
      );
      startBtn.disabled = false;
      stopBtn.disabled = true;
    };
  }

  // Only show the panel in the frame that actually contains the parameter form.
  const poll = setInterval(() => {
    if (byId('_paramscustacno') && document.body) {
      clearInterval(poll);
      buildPanel();
    }
  }, 1000);
})();
