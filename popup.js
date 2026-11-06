/**
 * popup.js — VTOP-AP Survey Bypasser
 * Manages the popup UI state, star rating preference, and
 * communicates start/stop signals to the content script via chrome.storage.local.
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────
const RATING_DESCRIPTIONS = {
  1: '1 · Poor',
  2: '2 · Fair',
  3: '3 · Average',
  4: '4 · Very good',
  5: '5 · Excellent',
};

// ─── DOM refs ────────────────────────────────────────────────────────────────
const btnStart       = document.getElementById('btnStart');
const statusCard     = document.getElementById('statusCard');
const statusDot      = document.getElementById('statusDot');
const statusValue    = document.getElementById('statusValue');
const counterPosted  = document.getElementById('counterPosted');
const counterPending = document.getElementById('counterPending');

const starPicker     = document.getElementById('starPicker');
const starButtons    = document.querySelectorAll('.star-btn');
const ratingBadge    = document.getElementById('ratingBadge');
const presetTags     = document.querySelectorAll('.preset-tag');
const infoRatingText = document.getElementById('infoRatingText');

let currentRating = 5;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generates a visual star glyph string (e.g. ★★★★☆).
 * @param {number} rating
 * @returns {string}
 */
function getStarString(rating) {
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

/**
 * Updates star buttons, badge, preset tags, and info text for the specified rating.
 * @param {number} rating
 */
function renderRatingUI(rating) {
  currentRating = rating;

  // Update star buttons
  starButtons.forEach(btn => {
    const val = parseInt(btn.dataset.value, 10);
    btn.classList.toggle('active', val === rating);
  });

  // Update rating description badge
  if (ratingBadge) {
    ratingBadge.textContent = RATING_DESCRIPTIONS[rating] || `${rating}`;
  }

  // Update quick preset tags
  presetTags.forEach(tag => {
    const val = parseInt(tag.dataset.preset, 10);
    tag.classList.toggle('active', val === rating);
  });
}

/**
 * Checks if a URL belongs to the VTOP domain (*.vitap.ac.in).
 * @param {string} url
 * @returns {boolean}
 */
function isVtopUrl(url) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return /(^|\.)vitap\.ac\.in$/i.test(hostname);
  } catch {
    return false;
  }
}

/**
 * Syncs the popup UI to the current storage state.
 * @param {object} state - The chrome.storage.local snapshot.
 * @param {boolean} [isOnVtop=true]
 */
function renderUI(state, isOnVtop = true) {
  const isActive = !!state.autoFillActive;

  // Button
  btnStart.textContent = isActive ? 'Stop' : 'Start';
  btnStart.className   = `btn-start ${isActive ? 'running' : 'idle'}`;

  // Status line
  let dot = '', text = 'Ready';
  if (!isOnVtop) {
    dot = 'stopped'; text = 'Open a VTOP page first';
  } else if (state.autoFillError && !isActive) {
    dot = 'stopped'; text = state.autoFillError;
  } else if (state.autoFillComplete) {
    dot = 'done'; text = 'Finished. All feedback submitted';
  } else if (isActive) {
    dot = 'active'; text = 'Running';
  }
  statusDot.className  = `status-dot ${dot}`;
  statusCard.className = '';
  statusValue.textContent = text;

  // Counters
  counterPosted.textContent  = state.submittedCount  ?? 0;
  counterPending.textContent = state.pendingCount != null ? state.pendingCount : '–';

  // Star Rating preference
  const rawRating = state.targetRating != null ? Number(state.targetRating) : 5;
  const rating = Math.min(5, Math.max(1, isNaN(rawRating) ? 5 : Math.round(rawRating)));
  renderRatingUI(rating);
}

/**
 * Reads current storage state and active tab to update the UI.
 */
async function refreshUI() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const isOnVtop = tabs.length > 0 && isVtopUrl(tabs[0].url);

  chrome.storage.local.get(
    ['autoFillActive', 'autoFillComplete', 'autoFillError', 'submittedCount', 'pendingCount', 'targetRating'],
    (state) => renderUI(state, isOnVtop)
  );
}

// ─── Star rating interaction listeners ───────────────────────────────────────
if (starPicker) {
  starButtons.forEach(btn => {
    // Hover preview
    btn.addEventListener('mouseenter', () => {
      const hoverVal = parseInt(btn.dataset.value, 10);
      starButtons.forEach(b => {
        const val = parseInt(b.dataset.value, 10);
        b.classList.toggle('hovered', val === hoverVal && val !== currentRating);
      });
      if (ratingBadge) {
        ratingBadge.textContent = RATING_DESCRIPTIONS[hoverVal] || `${hoverVal}`;
      }
    });

    // Rating selection click
    btn.addEventListener('click', async () => {
      const val = parseInt(btn.dataset.value, 10);
      btn.classList.add('pop');
      setTimeout(() => btn.classList.remove('pop'), 300);

      renderRatingUI(val);
      await chrome.storage.local.set({ targetRating: val });
    });
  });

  // Revert hover preview on mouse leave
  starPicker.addEventListener('mouseleave', () => {
    starButtons.forEach(b => b.classList.remove('hovered'));
    if (ratingBadge) {
      ratingBadge.textContent = RATING_DESCRIPTIONS[currentRating] || `${currentRating}`;
    }
  });
}

// Preset tags click handler
presetTags.forEach(tag => {
  tag.addEventListener('click', async () => {
    const val = parseInt(tag.dataset.preset, 10);
    const targetBtn = document.querySelector(`.star-btn[data-value="${val}"]`);
    if (targetBtn) {
      targetBtn.classList.add('pop');
      setTimeout(() => targetBtn.classList.remove('pop'), 300);
    }
    renderRatingUI(val);
    await chrome.storage.local.set({ targetRating: val });
  });
});

// ─── Button click handler ─────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs.length > 0 ? tabs[0] : null;
  const state = await chrome.storage.local.get(['autoFillActive']);

  if (state.autoFillActive) {
    // ── STOP ──────────────────────────────────────────────
    await chrome.storage.local.set({ autoFillActive: false });
    renderUI({ autoFillActive: false, targetRating: currentRating }, isVtopUrl(activeTab?.url));
  } else {
    // ── Check if tab is on VTOP before starting ───────────
    if (!activeTab || !isVtopUrl(activeTab.url)) {
      renderUI({ autoFillActive: false, targetRating: currentRating }, false);
      return;
    }

    // ── START ─────────────────────────────────────────────
    // Clear any stale completion flag from a previous run while preserving targetRating
    await chrome.storage.local.set({
      autoFillActive:   true,
      autoFillComplete: false,
      autoFillError:    null,
      doneKeys:         [],
      exhaustedTypes:   [],
      skipped:          [],
      selSteps:         0,
      submitInFlight:   false,
      consecutiveSubmits: 0,
      submittedCount:   0,
      pendingCount:     null,
      targetRating:     currentRating,
    });

    renderUI({ autoFillActive: true, submittedCount: 0, targetRating: currentRating }, true);

    // Signal the already-injected content script to start — NO reload.
    // Reloading triggers VTOP's multi-session guard and logs the user out.
    const tabId = activeTab.id;

    // Try messaging the already-injected content script first.
    chrome.tabs.sendMessage(tabId, { action: 'START_AUTOFILL' }, (response) => {
      if (chrome.runtime.lastError) {
        // sendMessage failed — content script is not present in this tab.
        // This happens when the extension is reloaded but the VTOP tab was
        // NOT refreshed afterward. Fix: inject content.js programmatically.
        // This does NOT reload the page, so no VTOP session risk.
        chrome.scripting.executeScript({
          target: { tabId },
          files:  ['content.js'],
        }).catch((err) => {
          console.error('[VTOP-Auto] executeScript error:', err);
        }).finally(() => {
          window.close();
        });
      } else {
        window.close();
      }
    });
  }
});

// ─── Storage change listener (live updates while popup is open) ───────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') refreshUI();
});

// ─── Initial render on popup open ────────────────────────────────────────────
refreshUI();


// ─── Comment text (required free-text rows) ──────────────────────────────────
const commentInput = document.getElementById('commentInput');
if (commentInput) {
  chrome.storage.local.get(['commentText'], (st) => {
    commentInput.value = st.commentText != null ? st.commentText : 'Good';
    if (st.commentText == null) chrome.storage.local.set({ commentText: commentInput.value });
  });
  commentInput.addEventListener('input', () => {
    const clean = commentInput.value.replace(/[^A-Za-z0-9 ]/g, '');
    if (clean !== commentInput.value) commentInput.value = clean;
    chrome.storage.local.set({ commentText: clean });
  });
}
