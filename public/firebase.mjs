import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";
const firebaseConfig = {
  apiKey: "AIzaSyCysjpUPbo7gKp43qq8RH2MZOa2V6CdG0k",
  authDomain: "gamehub-7b1e2.firebaseapp.com",
  projectId: "gamehub-7b1e2",
  storageBucket: "gamehub-7b1e2.firebasestorage.app",
  messagingSenderId: "888149575208",
  appId: "1:888149575208:web:4e1827a7d2a5b07535171d",
  measurementId: "G-5BJ71XNGQC"
};
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const authProvider = getAuth(app);
export * as firestore from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";
export * as auth from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";