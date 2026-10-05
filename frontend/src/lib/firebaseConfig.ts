// Firebase web config for project "build-chords-listener" (web app "chords-listener-web").
// Web config values identify the project; they are not secrets. Access to data is enforced by
// Firebase Auth + /firestore.rules.
//
// Kept apart from lib/firebase.ts (which pulls in the SDK) so lib/authMarker.ts can read it without
// loading Firebase.
export const firebaseConfig = {
  apiKey: 'AIzaSyBL5s4iSoBMrQNIlpYA4WQSjP5tP_4xmUU',
  authDomain: 'build-chords-listener.firebaseapp.com',
  projectId: 'build-chords-listener',
  storageBucket: 'build-chords-listener.firebasestorage.app',
  messagingSenderId: '84488579848',
  appId: '1:84488579848:web:0072b14b7aa305ef73dabd',
  measurementId: 'G-DCYT55LJJ2',
}
