# CoWorker Tracker

A small web app for two things:

1. **Waiting on**: log the emails you send coworkers asking for something (who, what, when sent), see how long each has been waiting, log follow-ups, copy a ready-made nudge email, and mark items resolved when you get an answer. Overdue items (past their "need by" date) turn red; items with no reply for too long (2 days by default, adjustable) turn amber.
2. **To-do**: a personal to-do list with due dates and priorities, grouped into Overdue, Today, Next 7 days, Later and No date.

There is no Outlook or email connection. Everything is entered by hand. All times are shown and entered in **Sydney time**, whatever time zone your device is set to.

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

3. Click **Deploy**. Note your site's address, e.g. `coworker-tracker.vercel.app`.

### 3. Let Google sign-in work on your Vercel address

Back in Firebase: **Authentication → Settings → Authorized domains → Add domain**, and add your Vercel address (e.g. `coworker-tracker.vercel.app`). Without this, the sign-in popup is refused.

Open the site, click **Sign in with Google**, and you're in.

> The Firebase web settings above aren't secret (they end up in every Firebase web app's browser code). What protects your data is the sign-in plus the Firestore rules from step 1.4.

## Using it

- **Log an email you sent**: who, what you're waiting for, when you sent it (defaults to now), and optionally a date you need it by.
- **Log follow-up** when you chase someone (email, Teams, call, in person). This resets the "no reply" clock but the total waiting time keeps counting from the first email.
- **Copy nudge text** puts a polite follow-up on your clipboard to paste into Outlook.
- **Got it ✓** marks it resolved. The summary at the top shows your average time to get an answer.
- **History** shows the full timeline for an item.
- **Download a backup** (bottom of the page) saves everything as a JSON file.

## Developing

- `npm test` runs the tests for the time-zone and status rules (needs Node 20+).
- `npx vercel dev` runs the site locally with the `/api/config` function. Put the same `FIREBASE_*` values in a `.env.local` file, and add `localhost` to Firebase's authorized domains (it's there by default).
- To preview the screens without Firebase, serve the `public/` folder with any static server and open `/?demo`.

### Layout

| Path | What it is |
| --- | --- |
| `public/index.html`, `public/styles.css` | The page |
| `public/app.js` | Screens and interactions |
| `public/logic.js` | Rules for overdue / needs-a-nudge, and the nudge email text |
| `public/time.js` | Sydney time-zone helpers |
| `public/store.js` | Firestore (live) and browser-only (demo) storage |
| `api/config.js` | Vercel function that hands the browser the Firebase settings |
| `firestore.rules` | Firestore security rules |
| `test/` | Tests |

Firestore layout: `users/{uid}` holds settings, with `requests` and `todos` subcollections underneath.
