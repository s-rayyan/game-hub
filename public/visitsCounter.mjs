import { db, authProvider, auth, firestore } from "./firebase.mjs";

export async function logVisit() {
  const userCred = await auth.signInAnonymously(authProvider);
  const uid = userCred.user.uid;
  const userRef = firestore.doc(db, "users", uid);
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
}


