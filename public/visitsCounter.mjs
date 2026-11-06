import { db, authProvider, auth, firestore } from "./firebase.mjs";

export async function logVisit() {
  try {
    // Wait for Firebase to restore any saved session first. Calling signInAnonymously while a
    // Google user is signed in would replace them with a throwaway anonymous one.
    await authProvider.authStateReady();
    const user = authProvider.currentUser ?? (await auth.signInAnonymously(authProvider)).user;
    const userRef = firestore.doc(db, "users", user.uid);
    const snap = await firestore.getDoc(userRef);

    if (!snap.exists()) {
      await firestore.setDoc(userRef, {
        visits: 1,
        createdAt: Date.now(),
      });
    } else {
      await firestore.updateDoc(userRef, {
        visits: (snap.data().visits || 0) + 1,
        lastVisit: Date.now(),
      });
    }
  } catch (err) {
    // Visit counting is best-effort and must never get in the way of the hub.
    console.warn("Could not log visit:", err);
  }
}
