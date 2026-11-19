# Cloud account setup (one time, free)

1. https://console.firebase.google.com -> Add project (Analytics off). Stay on the free Spark plan.
2. Build -> Authentication -> Get started -> Sign-in method -> Google -> Enable.
3. Authentication -> Settings -> Authorized domains -> add `jblagana.github.io` (the site that serves the app).
4. Build -> Firestore Database -> Create database (production mode) -> Rules tab -> paste `firestore.rules` -> Publish.
5. Project settings -> Your apps -> Web (</>) -> register -> copy the `firebaseConfig` object.
6. In the app: Settings -> Cloud account -> paste the config -> Save config -> Continue with Google -> set the passphrase.
   (Or put the object in `CLOUD_CFG` in app.js so every user gets it without pasting.)

The web config is not a secret (it only names the project); the rules and the passphrase are what protect the data.
