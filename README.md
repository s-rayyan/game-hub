# Rayyan's Game Hub
This website was developed as a test to see how simple it is to develop a simple gaming platform using the programming languages `HTML` `Javascript` `CSS` and the `JQuery` framework.


## Optional Google sign-in (cloud saves)

Signing in is optional. Signed out, everything works as before and saves stay in the browser. Signed in with Google, the hub (favorites, theme, playtime) and every game's `localStorage` saves are synced to the account's Firestore data at `users/{uid}/saves`, so progress follows you across devices. Games that keep their saves in IndexedDB (many Unity builds) are not synced yet.

How it works: `public/syncCore.mjs` (pure merge logic), `public/cloudSync.mjs` (Firestore I/O and scheduling), `public/userData.mjs` (sign-in button and panel). Run the logic tests with `node --test test/`.

One-time Firebase setup:

1. Firebase console → Authentication → Sign-in method → enable **Google**.
2. Authentication → Settings → Authorized domains → add every domain that serves the hub (e.g. the Render domain; `*.web.app` and `localhost` are already allowed).
3. Deploy the updated security rules: `firebase deploy --only firestore:rules`.
