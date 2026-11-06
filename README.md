# VTOP Feedback Filler

A Chrome extension that completes the course feedback forms on the VIT-AP student portal (VTOP) for you. Choose a rating once, press Start, and it goes through every feedback option and course, fills the form and submits it.

Version 1.4.1 · Manifest V3 · Works on Chrome, Edge and Brave

---

## What it does

- Selects the same rating (1 to 5) for every rating question on the form.
- Types a short piece of text into the required comment boxes (rows 8 and 9), which VTOP will not accept empty.
- Clicks Submit, then moves to the next course automatically.
- Works through every option in the **Feedback Option** dropdown (for example Theory and Lab) and every course in **Course Title**.
- Skips any course that shows no form, for example one already submitted, and lists it in the browser console at the end.
- Shows live counts of submitted and remaining forms in the popup.

## Privacy

- It runs only on `https://vtop.vitap.ac.in/vtop/*`.
- It makes no network requests of its own. There are no servers, analytics or trackers.
- Your rating and comment text are kept in Chrome's local extension storage on your computer, and nowhere else.
- Permissions requested: `storage` (remember your settings and progress), `scripting` and `tabs` (start the script on the open VTOP tab).

---

## Installation

1. Download `VTOP_Feedback_Filler.zip` and extract it to a normal folder. Do not delete the folder afterwards, because Chrome loads the extension from it.
2. Open `chrome://extensions` in Chrome, Edge or Brave.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the extracted folder, the one that contains `manifest.json`.
5. Optional: pin the extension from the puzzle-piece menu so the icon is always visible.

### Updating

Replace the old folder contents with the new version, click the reload icon on the extension in `chrome://extensions`, then refresh the VTOP tab once.

---

## How to use

1. Log in to VTOP at `vtop.vitap.ac.in`.
2. Open the **Feedback Form** page, where the Year, Feedback Option and Course Title dropdowns are visible.
3. Click the extension icon.
4. Choose a rating from **1 to 5**.
5. Set the **Text for required comment boxes**. The default is `Good`. Only letters, digits and spaces are accepted by VTOP, so anything else is removed. Leave it empty if you want to fill those boxes yourself.
6. Click **Start**. The popup closes and the work happens on the page.
7. Reopen the popup at any time to see progress, or click **Stop** to halt immediately.
8. When it finishes, the popup shows "Finished. All feedback submitted" and a banner appears on the page.

Tips:

- Do not reload or navigate away from VTOP while it runs. VTOP sessions time out quickly and a reload can log you out.
- Start from the feedback page, not the VTOP home page.
- Keep the tab open and in front. Browsers slow down background tabs.

---

## Safety limits

The extension stops by itself, with the reason shown in the popup, when:

- a required field is empty or invalid and the form cannot be submitted;
- a Submit button appears but there are no rating options on the page;
- a submit fails twice in a row;
- the Feedback Option or Course Title dropdowns cannot be found;
- it has taken more than 300 steps, which means something is looping.

---

## Troubleshooting

| Problem | What to try |
|---|---|
| Popup says "Open a VTOP page first" | The active tab is not on `vtop.vitap.ac.in`. Switch to it and try again. |
| Nothing happens after Start | Refresh the VTOP tab once, then Start again. This is needed after installing or reloading the extension. |
| "Could not find the Feedback Option / Course Title dropdowns" | You are not on the feedback form page, or the session timed out. Log in again and open the page. |
| "A required field is empty or invalid" | Set the comment text in the popup, or fill that field by hand and press Start again. |
| "Submit did not go through" | VTOP rejected the form. Submit one course manually to see which field it complains about. |
| Logged out midway | The VTOP session expired. Log in, open the feedback page and press Start. Courses already submitted are skipped. |

If it still fails, open the browser console (F12, Console tab) and look for lines starting with `[VTOP-AP-Auto]`. They list what the script saw on the page and make problems much easier to diagnose.

---

## Limitations

- It is built for the current VIT-AP VTOP feedback page. If VTOP changes the layout or labels, it may need an update.
- Every form gets the same rating and the same comment text. It does not read the questions.
- It does not bypass any login, session or server-side check. It only fills in and submits forms that you could fill in yourself.

---

## Project structure

| File | Purpose |
|---|---|
| `manifest.json` | Extension definition, permissions and the VTOP-only match rule |
| `content.js` | Runs on the VTOP page: finds the dropdowns, fills the forms, submits, moves on |
| `popup.html`, `popup.js` | The popup: rating, comment text, Start/Stop, progress |
| `background.js` | Service worker |
| `icons/` | Extension icons |

---

## Disclaimer

This is an unofficial tool. It is not made by, endorsed by or affiliated with VIT-AP University. Feedback is meant to help improve teaching, so if you have something useful to say about a course or a faculty member, fill that form in yourself. You are responsible for how you use this tool and for following your university's rules.

---

## Author

Made by [@abhiravi1912](https://github.com/abhiravi1912)
