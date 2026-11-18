# CoWorker

A small web app for two things:

1. **To-do** (the main screen): a personal to-do list with due dates and priorities, grouped into Overdue, Today, Next 7 days, Later and No date.
2. **Waiting on**: a reference log of what you've asked coworkers for (who, what, when sent) and how long each one has gone without a reply. Press **Got a response** when an answer comes in, and the app records how long it took. The summary shows how many requests you've sent, how many are still unanswered, and the average time to get an answer. Items past an optional "need by" date show as Overdue.

There is no Outlook or email connection. To log an email quickly, **paste a screenshot of it** (or its text) and Gemini fills in who it went to, what you asked for, and when it was sent. You check the details and press Start tracking. All times are shown and entered in **Melbourne time** (Drouin), whatever time zone your device is set to.

It is a static site with one tiny serverless function, hosted on **Vercel**, with data stored in **Firebase (Cloud Firestore)** behind Google sign-in. Your data is private to your Google account and syncs between your computer and phone.

Want to just look at it first? Open the site with `?demo` on the end of the address. Demo mode saves to that browser only.

## One-time setup (about 15 minutes)

### 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> and click **Create a project** (e.g. `coworker-tracker`). Google Analytics is not needed.
2. **Build → Authentication → Get started → Sign-in method → Google → Enable.** Pick your support email and save.
3. **Build → Firestore Database → Create database.** Choose the `australia-southeast1` (Sydney) location and start in **production mode**.
4. In Firestore, open the **Rules** tab, replace everything with the contents of [`firestore.rules`](firestore.rules), and click **Publish**. These rules mean each signed-in person can only see their own data.
5. **Project settings (gear icon) → General → Your apps → Web (`</>`)**. Register an app (no Firebase Hosting needed). Firebase shows a `firebaseConfig` block; keep it open for the next step.

### 2. Deploy on Vercel

1. In Vercel, **Add New → Project** and import this GitHub repository. Leave the framework preset as **Other**; `vercel.json` already sets everything.
2. Before deploying, add these **Environment Variables** using the values from the `firebaseConfig` block:

   | Vercel variable | From `firebaseConfig` |
   | --- | --- |
   | `FIREBASE_API_KEY` | `apiKey` |
   | `FIREBASE_AUTH_DOMAIN` | `authDomain` |
   | `FIREBASE_PROJECT_ID` | `projectId` |
   | `FIREBASE_APP_ID` | `appId` |

3. For the screenshot reader, also add:

   | Vercel variable | Value |
   | --- | --- |
   | `GEMINI_API_KEY` | A key from <https://aistudio.google.com/apikey> (sign in with Google, click **Create API key**) |
   | `ALLOWED_EMAILS` | Optional but recommended: your Google sign-in email, so only you can use your Gemini key |
   | `GEMINI_MODEL` | Optional. Defaults to `gemini-flash-latest` |

   The Gemini key stays on Vercel's servers. The browser never sees it, and the reader only works for signed-in users.

4. Click **Deploy**. Note your site's address, e.g. `coworker-tracker.vercel.app`.

### 3. Let Google sign-in work on your Vercel address

Back in Firebase: **Authentication → Settings → Authorized domains → Add domain**, and add your Vercel address (e.g. `coworker-tracker.vercel.app`). Without this, the sign-in popup is refused.

Open the site, click **Sign in with Google**, and you're in.

> The Firebase web settings above aren't secret (they end up in every Firebase web app's browser code). What protects your data is the sign-in plus the Firestore rules from step 1.4.

## Optional: an email address you can BCC

Set this up and you never type or screenshot again:

- **New emails:** add the capture address as **BCC** when you send. The item appears in the app with the real recipients and sent time. If you BCC it again on a reply in the same thread, that's logged as a follow-up instead of a new item.
- **Old emails you're still waiting on:** find them in Sent Items and **forward** them to the capture address. Gemini reads the original email, so the item is dated when you first sent it.

Items that arrive this way show an **Added from email** tag. Press **Looks right** (or Edit) once you've checked them.

> Check that your workplace allows BCC'ing or forwarding work email to an outside address before you use this.

Setup (about 15 minutes):

1. **Postmark** (free plan, 100 emails a month): sign up at <https://postmarkapp.com>, create a **Server**, and open its **Default Inbound Stream → Settings**.
   - Copy the **inbound address** (something like `1a2b3c…@inbound.postmarkapp.com`). This is your capture address. Save it as an Outlook contact called "Tracker" so it's quick to BCC.
   - Set the **Webhook URL** to `https://capture:YOUR_SECRET@coworker-tau.vercel.app/api/inbound`, using a long random password of your choice in place of `YOUR_SECRET`.
2. **Firebase service account** (lets the server save items for you): Firebase console → gear icon → **Project settings → Service accounts → Generate new private key**. This downloads a `.json` file.
3. **Vercel → Settings → Environment Variables**, add:

   | Vercel variable | Value |
   | --- | --- |
   | `INBOUND_SECRET` | The same password you put in the webhook URL |
   | `INBOUND_SENDERS` | Your work email address (comma-separate if more than one). Mail from anyone else is ignored. |
   | `INBOUND_UID` | Your **User ID for email capture**, shown at the bottom of the app once you've signed in (there's a copy button) |
   | `FIREBASE_SERVICE_ACCOUNT` | The entire contents of the `.json` file from step 2 |

   `GEMINI_API_KEY` is needed too (from the main setup). Without it, BCC'd emails still work, but use the subject line as the description, and forwarded emails can't be read.
4. **Redeploy** in Vercel, then BCC the capture address on a test email to yourself or a colleague.

Keep the service account file private, and delete the downloaded copy once it's in Vercel.

## Using it

- **Paste a screenshot of the sent email**: in Outlook, open the email in Sent Items, take a screenshot (Windows: `Win+Shift+S`, Mac: `Cmd+Ctrl+Shift+4`), then click the app and press `Ctrl+V`/`Cmd+V`. On a phone, tap the dashed box and pick the screenshot. Gemini fills in the form and highlights what it filled. Check it and press **Start tracking**. You can also paste the email's text instead.
- **Log an email you sent**: who, what you're waiting for, when you sent it (defaults to now), and optionally a date you need it by.
- **Got a response ✓** marks it answered (you can change the time the answer came in). The summary at the top shows your average time to get an answer.
- If you BCC the capture address on a chaser email, it's counted as a follow-up on the original item.
- **History** shows the full timeline for an item.
- **Download a backup** (bottom of the page) saves everything as a JSON file.

## Developing

- `npm test` runs the tests for the time-zone and status rules and the Gemini function (with Gemini mocked) (needs Node 20+).
- `npx vercel dev` runs the site locally with the `/api/config` function. Put the same `FIREBASE_*` values in a `.env.local` file, and add `localhost` to Firebase's authorized domains (it's there by default).
- To preview the screens without Firebase, serve the `public/` folder with any static server and open `/?demo`.

### Layout

| Path | What it is |
| --- | --- |
| `public/index.html`, `public/styles.css` | The page |
| `public/app.js` | Screens and interactions |
| `public/logic.js` | Status rules (waiting / overdue / answered) |
| `public/time.js` | Melbourne time-zone helpers |
| `public/store.js` | Firestore (live) and browser-only (demo) storage |
| `api/config.js` | Vercel function that hands the browser the Firebase settings |
| `api/inbound.js` | Webhook for the BCC / forward capture address (Postmark inbound) |
| `api/_lib/` | Shared Gemini and Firestore (REST, service account) helpers |
| `api/extract.js` | Vercel function that sends a screenshot or email text to Gemini (key stays server-side) |
| `public/quickadd.js` | Paste / drop / pick a screenshot and fill the form |
| `firestore.rules` | Firestore security rules |
| `test/` | Tests |

Firestore layout: `users/{uid}` holds settings, with `requests` and `todos` subcollections underneath.
