/**
 * content.js — VTOP-AP Survey Bypasser · Core Automation Engine
 *
 * Architecture:
 *  - On every VTOP page load, checks chrome.storage.local for the
 *    autoFillActive flag.
 *  - Uses a MutationObserver + periodic polling hybrid to detect when
 *    VTOP's asynchronously rendered tables are ready.
 *  - Scenario A: Course List page → clicks the first red "Post" button.
 *  - Scenario B: Feedback Form page → selects chosen star rating (1-5) for every
 *    row, skips textareas, then clicks the green Submit button.
 *
 * Storage keys used:
 *  autoFillActive   {boolean}  Master on/off switch
 *  autoFillComplete {boolean}  Set true when all feedback is done
 *  submittedCount   {number}   Incremented after each successful submit
 *  pendingCount     {number}   Updated on the course-list page
 *  targetRating     {number}   Selected star rating (1-5, defaults to 5)
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum time (ms) to wait for async table rendering before giving up. */
const OBSERVER_TIMEOUT_MS = 20_000;

/** Delay (ms) between selecting all stars and clicking Submit, giving the
 *  VTOP Angular/jQuery listeners time to register each click event. */
const PRE_SUBMIT_DELAY_MS = 600;

/** How often (ms) the fallback polling interval re-checks the DOM. */
const POLL_INTERVAL_MS = 500;

/** Max submit clicks without ever returning to the course list. Prevents
 *  infinite loops if a submit is rejected (validation / server error). */
const MAX_CONSECUTIVE_SUBMITS = 2;

/** Stops automation and records a human-readable reason for the popup. */
function abortWithError(message) {
  console.warn('[VTOP-AP-Auto]', message);
  chrome.storage.local.set({ autoFillActive: false, autoFillError: message });
}

// ─── Entry point ─────────────────────────────────────────────────────────────

(function init() {
  // ── Triggered on page load (handles post-navigation cycles) ──────────────
  chrome.storage.local.get(
    ['autoFillActive', 'submittedCount', 'pendingCount', 'targetRating'],
    (state) => {
      if (chrome.runtime.lastError) {
        console.warn('[VTOP-AP-Auto] Storage read error:', chrome.runtime.lastError);
        return;
      }
      if (!state.autoFillActive) return; // Automation not active — do nothing.
      waitForPageReady(onPageReady);
    }
  );

  // ── Triggered by popup's sendMessage (first activation, no reload) ────────
  // This allows the popup to start automation on the CURRENT page without
  // reloading it, which would trigger VTOP's multi-session guard and log
  // the user out.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'START_AUTOFILL') {
      waitForPageReady(onPageReady);
      sendResponse({ status: 'started' });
    }
  });
})();

// ─── Core element waiter ─────────────────────────────────────────────────────

/**
 * Generic DOM waiter: polls + observes until predicate() returns true,
 * then fires callback exactly once and cleans up.
 *
 * Used by both the page-load path AND the post-click AJAX fallback path so
 * the automation continues regardless of whether VTOP uses full-page
 * navigation or inline AJAX rendering.
 *
 * @param {Function} predicate     Returns true when the awaited state is ready.
 * @param {Function} callback      Called once when predicate is satisfied.
 * @param {number}  [timeoutMs]    Give up after this many ms (default 20 s).
 */
function waitForElement(predicate, callback, timeoutMs = OBSERVER_TIMEOUT_MS) {
  if (predicate()) { callback(); return; }

  // Guard: body may be null if called during early page load
  if (!document.body) {
    setTimeout(() => waitForElement(predicate, callback, timeoutMs), 100);
    return;
  }

  let settled = false;

  function resolve() {
    if (settled) return;
    settled = true;
    clearInterval(pollTimer);
    observer.disconnect();
    callback();
  }

  const observer = new MutationObserver(() => { if (predicate()) resolve(); });
  observer.observe(document.body, { childList: true, subtree: true });

  const pollTimer = setInterval(() => { if (predicate()) resolve(); }, POLL_INTERVAL_MS);

  setTimeout(() => {
    if (!settled) {
      settled = true;
      clearInterval(pollTimer);
      observer.disconnect();
      console.warn('[VTOP-AP-Auto] waitForElement timed out.');
      // Diagnostics: list visible clickable texts so selectors can be tuned.
      const seen = [...document.querySelectorAll('button, input[type="button"], input[type="submit"], a')]
        .filter(el => el.offsetWidth > 0 || el.offsetHeight > 0)
        .map(el => (el.value || el.textContent || '').trim().replace(/\s+/g, ' '))
        .filter(t => t && t.length < 40);
      console.warn('[VTOP-AP-Auto] Visible button/link texts:', [...new Set(seen)].slice(0, 60));
      console.warn('[VTOP-AP-Auto] Radios on page:', document.querySelectorAll('input[type="radio"]').length,
                   '| iframes:', document.querySelectorAll('iframe').length);
      console.warn('[VTOP-AP-Auto] Selects:', [...document.querySelectorAll('select')].map(x => ({
        id: x.id, name: x.name, options: x.options.length, label: labelTextForSelect(x).slice(0, 60) })));
      chrome.storage.local.set({
        autoFillActive: false,
        autoFillError: 'Timed out: no Post/Submit button found. Open the feedback course list first (see console for details).'
      });
    }
  }, timeoutMs);
}

/**
 * Waits until the VTOP page has rendered its core interactive elements
 * (Post/Posted buttons or the feedback Submit button).
 *
 * @param {Function} callback  Called once page is ready.
 */
function waitForPageReady(callback) {
  waitForElement(isPageReady, callback);
}

/**
 * Returns true when either course buttons ("Post" / "Posted") OR the
 * feedback form Submit button is present in the DOM.
 */
function isPageReady() {
  if (findPostButtons().length > 0) return true;
  if (findPostedElements().length > 0) return true;
  if (findSubmitButton()) return true;
  if (findFeedbackSelects()) return true;
  return false;
}

// ─── Main dispatch ────────────────────────────────────────────────────────────

/**
 * Called once the page is ready. Determines which scenario we are in
 * and delegates accordingly.
 */
function onPageReady() {
  // Re-read storage in case the user stopped the automation or changed rating while we waited
  chrome.storage.local.get(['autoFillActive', 'targetRating', 'commentText'], (state) => {
    if (!state.autoFillActive) return;

    const rawRating = state.targetRating != null ? Number(state.targetRating) : 5;
    const targetRating = Math.min(5, Math.max(1, isNaN(rawRating) ? 5 : Math.round(rawRating)));

    const submitBtn = findSubmitButton();
    // A Submit button that is the very element we just clicked is a stale
    // (already submitted) form: never submit it twice.
    const freshSubmit = submitBtn && submitBtn !== lastSubmitEl ? submitBtn : null;

    if (freshSubmit)               handleFeedbackForm(freshSubmit, targetRating, state.commentText);
    else if (findFeedbackSelects()) handleSelectionFlow();
    else if (submitBtn)            abortWithError('Form stayed open after submit and no course selector found. Stopped.');
    else                           handleCourseList();
  });
}

// ─── Scenario A: Course List ──────────────────────────────────────────────────

/**
 * Scans the DOM for a red "Post" button (exact text, case-sensitive).
 * Clicks the first one found, or signals completion if none remain.
 */
function handleCourseList() {
  const postButtons = findPostButtons();
  const postedCount = findPostedElements().length;

  // Reaching the course list again means the previous submit went through:
  // count it now (not at click time) and reset the retry guard.
  chrome.storage.local.get(['submitInFlight', 'submittedCount'], (st) => {
    const upd = { pendingCount: postButtons.length, consecutiveSubmits: 0, submitInFlight: false };
    if (st.submitInFlight) upd.submittedCount = (st.submittedCount || 0) + 1;
    chrome.storage.local.set(upd);
  });

  if (postButtons.length === 0) {
    chrome.storage.local.set({
      autoFillActive:   false,
      autoFillComplete: true,
      pendingCount:     0,
    }, () => {
      // Show a visible notification overlay instead of alert()
      // so we don't block the page inside a content script context
      chrome.storage.local.get(['targetRating'], (state) => {
        const rating = Number(state.targetRating) || 5;
        showCompletionBanner(postedCount, rating);
      });
    });
    return;
  }

  // Click the first available "Post" button
  const target = postButtons[0];
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });

  setTimeout(() => {
    target.click();

    // ── AJAX / SPA fallback ─────────────────────────────────────────────────
    // If VTOP loads the feedback form without a full page navigation (e.g. via
    // AJAX into the same frame), the Submit button will appear in the current
    // DOM and this watcher will catch it.
    // If VTOP DOES do a full page reload, this observer is garbage-collected
    // the moment the page unloads and the fresh content.js handles everything.
    // The 300 ms delay gives the click's navigation/AJAX time to begin so
    // we don't accidentally match a stale Submit button from a prior state.
    setTimeout(() => {
      waitForElement(() => !!findSubmitButton(), onPageReady);
    }, 300);
  }, 350);
}

/**
 * Returns all clickable elements whose visible text is "Post" (case-insensitive,
 * not "Posted"). Checks buttons, inputs, and links.
 */
function findPostButtons() {
  const candidates = [
    ...document.querySelectorAll('button'),
    ...document.querySelectorAll('input[type="button"]'),
    ...document.querySelectorAll('input[type="submit"]'),
    ...document.querySelectorAll('a'),
  ];

  return candidates.filter(el => {
    // Ignore disabled or hidden elements (like template rows)
    if (el.disabled) return false;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;

    const text = (el.value || el.textContent || '').trim().toLowerCase();
    return text === 'post';
  });
}

/**
 * Returns all elements whose text is "Posted" (already completed rows).
 */
function findPostedElements() {
  const candidates = [
    ...document.querySelectorAll('button'),
    ...document.querySelectorAll('input[type="button"]'),
    ...document.querySelectorAll('input[type="submit"]'),
    ...document.querySelectorAll('span'),
    ...document.querySelectorAll('td'),
    ...document.querySelectorAll('a'),
  ];

  return candidates.filter(el => {
    // Ignore hidden elements
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;

    const text = (el.value || el.textContent || '').trim().toLowerCase();
    return text === 'posted';
  });
}

// ─── Scenario B: Feedback Form ────────────────────────────────────────────────

/**
 * Finds the radio input that best matches the desired rating (1 to 5).
 *
 * Strategy order:
 *  1. Exact numeric value match (e.g. value="4" or value="4.0")
 *  2. Closest numeric value if on a different scale (e.g. 1-3 or 1-10)
 *  3. Positional fallback by index if values are non-numeric strings
 *     (e.g., maps rating 1..5 across available radios from 0 to length - 1)
 *
 * @param {HTMLInputElement[]} radios
 * @param {number} targetRating
 * @returns {HTMLInputElement|null}
 */
function findTargetRadio(radios, targetRating = 5) {
  if (!radios || radios.length === 0) return null;

  // 1. Exact numeric value match
  for (const r of radios) {
    const val = parseFloat(r.value);
    if (!isNaN(val) && val === targetRating) {
      return r;
    }
  }

  // 2. Closest numeric value
  const numericList = radios
    .map(r => ({ radio: r, val: parseFloat(r.value) }))
    .filter(item => !isNaN(item.val));

  if (numericList.length > 0) {
    numericList.sort((a, b) => Math.abs(a.val - targetRating) - Math.abs(b.val - targetRating));
    return numericList[0].radio;
  }

  // 3. Positional index fallback: map 1..5 across available radios
  const targetIndex = Math.min(Math.max(targetRating - 1, 0), radios.length - 1);
  return radios[targetIndex] || null;
}

/**
 * Returns radio groups (by name) that look like rating rows, limited to the
 * form/container that holds the Submit button so unrelated radios elsewhere
 * on the page are never touched. Rows containing a textarea are skipped.
 *
 * @param {Element} submitBtn
 * @returns {HTMLInputElement[][]}
 */
function collectRatingGroups(submitBtn) {
  const scope = submitBtn.closest('form') || document;
  const groups = new Map();
  scope.querySelectorAll('input[type="radio"]').forEach(radio => {
    if (isInsideTextareaRow(radio)) return;
    const name = radio.name || radio.id.replace(/\d+$/, '');
    if (!name) return;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(radio);
  });
  // A rating row has several options; 2-10 covers 1-5 / 1-10 style scales.
  return [...groups.values()].filter(g => g.length >= 2 && g.length <= 10);
}

/**
 * Selects the requested rating for every rating row, then clicks Submit.
 *
 * @param {Element} submitBtn
 * @param {number}  [targetRating=5]
 */
function handleFeedbackForm(submitBtn, targetRating = 5, commentText = '') {
  const groups = collectRatingGroups(submitBtn);

  // Safety: a Submit button with no rating rows is not a feedback form.
  if (groups.length === 0) {
    abortWithError('Submit button found but no rating options — not a feedback form. Stopped.');
    return;
  }

  groups.forEach(radios => {
    const best = findTargetRadio(radios, targetRating);
    if (!best || best.checked) return;
    const label = best.id ? document.querySelector(`label[for="${CSS.escape(best.id)}"]`) : null;
    if (label) label.click();
    else best.click();
    if (!best.checked) best.checked = true;
    best.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // VIT-AP marks the free-text rows as required, so fill any empty ones with
  // the comment the user typed in the popup (never invented text).
  fillRequiredTextFields(submitBtn, commentText);

  setTimeout(() => {
    chrome.storage.local.get(['consecutiveSubmits', 'autoFillActive', 'doneKeys', 'submittedCount'], (st) => {
      if (!st.autoFillActive) return;

      // Native HTML5 validation (required / pattern). If the form is invalid the
      // browser would block the submit, so stop with a clear reason instead.
      const formEl = submitBtn.closest('form');
      if (formEl && typeof formEl.checkValidity === 'function' && !formEl.checkValidity()) {
        abortWithError('A required field is empty or invalid — set Comment Text in the popup or fill it manually. Stopped.');
        return;
      }

      // ── Selector mode (VIT-AP): Year / Feedback Option / Course Title ──────
      if (findFeedbackSelects()) {
        const key = selectionKey();
        const done = new Set(st.doneKeys || []);
        if (key) done.add(key);
        chrome.storage.local.set({
          doneKeys: [...done],
          submittedCount: (st.submittedCount || 0) + 1,
          consecutiveSubmits: 0,
        }, async () => {
          submitBtn.click();
          lastSubmitEl = submitBtn;
          // Wait for the form to go away (or be replaced), then pick the next course.
          await waitUntil(() => !document.contains(submitBtn) || !isVisibleEl(submitBtn), 6000);
          await sleep(500);
          waitForElement(() => isPageReady(), onPageReady);
        });
        return;
      }

      // ── Course-list mode (original Post / Submit flow) ─────────────────────
      const attempts = (st.consecutiveSubmits || 0) + 1;
      if (attempts > MAX_CONSECUTIVE_SUBMITS) {
        abortWithError('Submit did not go through (form may need manual input). Stopped.');
        return;
      }
      chrome.storage.local.set({ consecutiveSubmits: attempts, submitInFlight: true }, () => {
        submitBtn.click();
        lastSubmitEl = submitBtn;
        setTimeout(() => waitForElement(() => isPageReady(), onPageReady), 1500);
      });
    });
  }, PRE_SUBMIT_DELAY_MS);
}

/**
 * Fills empty, visible, editable text inputs / textareas in the form with the
 * user-supplied comment. Only letters, digits and spaces are kept because the
 * VIT-AP fields state "Accepts only (a-z) or (A-Z) or (0-9)".
 */
function fillRequiredTextFields(submitBtn, commentText) {
  const text = String(commentText || '').replace(/[^A-Za-z0-9 ]/g, '').trim();
  if (!text) return;
  const scope = submitBtn.closest('form') || document;
  scope.querySelectorAll('textarea, input[type="text"], input:not([type])').forEach(el => {
    if (el.disabled || el.readOnly) return;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return;
    if (el.value && el.value.trim()) return;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
  });
}

/**
 * True if the element sits in a table row that also holds a <textarea>
 * ("Suggestions" rows must not get a star rating).
 */
function isInsideTextareaRow(el) {
  const row = el.closest('tr');
  return row ? !!row.querySelector('textarea, input[type="text"]') : false;
}

// ─── Scenario C: Year / Feedback Option / Course Title selectors (VIT-AP) ─────

/** Hard stop so a misbehaving page can never keep the loop running forever. */
const SELECT_STEP_LIMIT = 300;

/** The Submit button element we most recently clicked (stale-form guard). */
let lastSubmitEl = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isVisibleEl = (el) => el.offsetWidth > 0 || el.offsetHeight > 0;
const storageGet = (keys) => new Promise(r => chrome.storage.local.get(keys, r));
const storageSet = (obj)  => new Promise(r => chrome.storage.local.set(obj, r));

/** Polls pred() until true or ms elapses. Never aborts the automation. */
async function waitUntil(pred, ms = 6000, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return !!pred();
}

/** Text of the smallest ancestor that contains only this one <select>. */
function labelTextForSelect(sel) {
  if (sel.id) {
    const l = document.querySelector(`label[for="${CSS.escape(sel.id)}"]`);
    if (l) return l.textContent.toLowerCase();
  }
  let node = sel, text = '';
  while (node.parentElement) {
    const parent = node.parentElement;
    if (parent.querySelectorAll('select').length > 1) break;
    node = parent;
    text = node.textContent.toLowerCase();
  }
  return text;
}

/**
 * Finds the "Select Feedback Option" and "Select Course Title" dropdowns by
 * their label text. Both must match, so unrelated VTOP pages that merely
 * contain a <select> are never touched.
 */
function findFeedbackSelects() {
  let typeSel = null, courseSel = null;
  document.querySelectorAll('select').forEach(sel => {
    const t = labelTextForSelect(sel);
    if (!typeSel && t.includes('feedback option')) typeSel = sel;
    else if (!courseSel && t.includes('course title')) courseSel = sel;
  });
  return typeSel && courseSel ? { typeSel, courseSel } : null;
}

/** Options that are real choices (not "-- Choose ... --" placeholders). */
function realOptions(sel) {
  return [...sel.options].filter(o => {
    const txt = o.text.trim();
    return o.value && o.value.trim() !== '' && !txt.startsWith('--') && !/^(choose|select)\b/i.test(txt);
  });
}

function setSelect(sel, option) {
  sel.value = option.value;
  sel.dispatchEvent(new Event('input',  { bubbles: true }));
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

/** "<feedback option>||<course>" for the current selection, or null. */
function selectionKey() {
  const f = findFeedbackSelects();
  if (!f) return null;
  const t = f.typeSel.selectedOptions[0];
  const c = f.courseSel.selectedOptions[0];
  if (!t || !t.value || !c || !c.value) return null;
  return `${t.text.trim()}||${c.text.trim()}`;
}

function finishSelectionFlow() {
  chrome.storage.local.get(['submittedCount', 'skipped', 'targetRating'], (st) => {
    chrome.storage.local.set({ autoFillActive: false, autoFillComplete: true, pendingCount: 0 }, () => {
      const skipped = (st.skipped || []).length;
      if (skipped) console.warn('[VTOP-AP-Auto] Skipped (no form appeared):', st.skipped);
      showCompletionBanner(st.submittedCount || 0, Number(st.targetRating) || 5);
    });
  });
}

/**
 * Drives the dropdowns: for every Feedback Option, for every Course Title not
 * yet done, select it and wait for the form. onPageReady() then fills/submits.
 * Courses that show no form (already submitted / unavailable) are skipped.
 */
async function handleSelectionFlow() {
  const st = await storageGet(['autoFillActive', 'doneKeys', 'exhaustedTypes', 'skipped', 'selSteps']);
  if (!st.autoFillActive) return;

  const steps = (st.selSteps || 0) + 1;
  if (steps > SELECT_STEP_LIMIT) { abortWithError('Too many steps — stopped as a safety limit.'); return; }
  await storageSet({ selSteps: steps });

  const done      = new Set(st.doneKeys || []);
  const exhausted = new Set(st.exhaustedTypes || []);
  const skipped   = [...(st.skipped || [])];

  let f = findFeedbackSelects();
  if (!f) { abortWithError('Could not find the Feedback Option / Course Title dropdowns. Stopped.'); return; }

  const typeOpts = realOptions(f.typeSel);
  if (typeOpts.length === 0) { abortWithError('The Feedback Option dropdown has no choices. Stopped.'); return; }

  // 1. Make sure a not-yet-exhausted feedback option is selected.
  const cur = f.typeSel.selectedOptions[0];
  const curUsable = cur && cur.value && !exhausted.has(cur.text.trim());
  if (!curUsable) {
    const next = typeOpts.find(o => !exhausted.has(o.text.trim()));
    if (!next) { finishSelectionFlow(); return; }

    const before = [...f.courseSel.options].map(o => o.text).join('|');
    setSelect(f.typeSel, next);
    // Wait for the course list to be (re)loaded for this option.
    await waitUntil(() => {
      const nf = findFeedbackSelects();
      return nf && [...nf.courseSel.options].map(o => o.text).join('|') !== before;
    }, 3000);
    await waitUntil(() => { const nf = findFeedbackSelects(); return nf && realOptions(nf.courseSel).length > 0; }, 5000);
  }

  // 2. Pick the next course of this option that has not been handled.
  f = findFeedbackSelects();
  if (!f) { abortWithError('Dropdowns disappeared unexpectedly. Stopped.'); return; }
  const typeText = f.typeSel.selectedOptions[0].text.trim();
  const courses  = realOptions(f.courseSel);
  const remaining = courses.filter(o => !done.has(`${typeText}||${o.text.trim()}`));
  await storageSet({ pendingCount: remaining.length });

  if (remaining.length === 0) {
    exhausted.add(typeText);
    await storageSet({ exhaustedTypes: [...exhausted] });
    return handleSelectionFlow();
  }

  const course = remaining[0];
  const key = `${typeText}||${course.text.trim()}`;
  setSelect(f.courseSel, course);

  // 3. Wait for a *new* form (not the stale one we just submitted).
  const gotForm = await waitUntil(() => {
    const b = findSubmitButton();
    return !!b && b !== lastSubmitEl;
  }, 8000);

  if (!gotForm) {
    done.add(key);
    skipped.push(key);
    await storageSet({ doneKeys: [...done], skipped });
    return handleSelectionFlow();
  }
  onPageReady();
}

// ─── Submit button detection ──────────────────────────────────────────────────

/**
 * Finds the Submit button on the feedback form (case-insensitive).
 *
 * @returns {Element|null}
 */
function findSubmitButton() {
  const candidates = [
    ...document.querySelectorAll('input[type="submit"]'),
    ...document.querySelectorAll('input[type="button"]'),
    ...document.querySelectorAll('button'),
  ];

  return candidates.find(el => {
    if (el.disabled) return false;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;

    const text = (el.value || el.textContent || '').trim().toLowerCase();
    return text === 'submit';
  }) || null;
}

// ─── Completion banner ────────────────────────────────────────────────────────

/**
 * Injects a non-blocking, auto-dismissing completion banner into the page.
 * Avoids using window.alert() which blocks script execution inside
 * content scripts on some browsers.
 *
 * @param {number} totalPosted   Number of forms already in "Posted" state.
 * @param {number} [targetRating=5]
 */
function showCompletionBanner(totalPosted, targetRating = 5) {
  // Remove any existing banner
  document.getElementById('vtop-auto-banner')?.remove();

  const safeRating = Math.min(5, Math.max(1, Math.round(Number(targetRating) || 5)));

  const banner = document.createElement('div');
  banner.id = 'vtop-auto-banner';
  banner.innerHTML = `
    <div id="vtop-auto-inner">
      <div id="vtop-auto-icon">✅</div>
      <div>
        <strong>Feedback Automation Complete!</strong><br>
        <small>All available subjects submitted with ${safeRating}★ rating.</small>
      </div>
      <button id="vtop-auto-close" title="Dismiss">✕</button>
    </div>
  `;

  Object.assign(banner.style, {
    position:     'fixed',
    top:          '20px',
    right:        '20px',
    zIndex:       '2147483647',
    background:   'linear-gradient(135deg, #065f46, #047857)',
    color:        '#ecfdf5',
    borderRadius: '12px',
    boxShadow:    '0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.1)',
    fontFamily:   'Segoe UI, system-ui, sans-serif',
    fontSize:     '14px',
    padding:      '0',
    maxWidth:     '360px',
    animation:    'vtopSlideIn 0.4s ease',
  });

  const inner = banner.querySelector('#vtop-auto-inner');
  Object.assign(inner.style, {
    display:    'flex',
    alignItems: 'center',
    gap:        '14px',
    padding:    '16px 18px',
  });

  const icon = banner.querySelector('#vtop-auto-icon');
  Object.assign(icon.style, { fontSize: '28px', flexShrink: '0' });

  const closeBtn = banner.querySelector('#vtop-auto-close');
  Object.assign(closeBtn.style, {
    marginLeft:  'auto',
    background:  'none',
    border:      'none',
    color:       '#a7f3d0',
    fontSize:    '16px',
    cursor:      'pointer',
    flexShrink:  '0',
    padding:     '4px 6px',
    borderRadius:'6px',
  });

  // Inject keyframe animation once
  if (!document.getElementById('vtop-auto-style')) {
    const style = document.createElement('style');
    style.id = 'vtop-auto-style';
    style.textContent = `
      @keyframes vtopSlideIn {
        from { opacity: 0; transform: translateY(-20px) scale(0.95); }
        to   { opacity: 1; transform: translateY(0)    scale(1);    }
      }
    `;
    document.head.appendChild(style);
  }
  document.body.appendChild(banner);

  // Close on button click
  closeBtn.addEventListener('click', () => banner.remove());

  // Auto-dismiss after 8 seconds
  setTimeout(() => banner.remove(), 8000);
}
