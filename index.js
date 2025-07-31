const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();

const privateKey = `-----BEGIN PRIVATE KEY-----
שמים פה את המפתח הפרטי מתוך קובץ ה-service account שלך
-----END PRIVATE KEY-----`;

app.get('/token', (req, res) => {
  const jwtToken = jwt.sign(
    {
      iss: 'make-da-marketing@damarketing-xxxxx.iam.gserviceaccount.com', // שים פה את ה-client_email מתוך ה-JSON
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    },
    privateKey,
    { algorithm: 'RS256' }
  );

  res.send(jwtToken);
});

app.listen(process.env.PORT || 3000, () => {
  console.log('JWT Generator is live!');
});
