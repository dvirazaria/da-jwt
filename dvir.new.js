const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
const port = process.env.PORT || 3000;

// הקוד שלך ליצירת JWT (שים את פרטי החשבון שלך פה)
const privateKey = `-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCYgbaBemVv4rK0\nSF7nLQyyCSHMwoSX9Q1CzMf9z9g5KJF43SARIdkSu3vflGbsoqyHfgOxQX5Id/Dr\n2xEWebCi71MP+/FWf4OWBmYnHm41CutZJRdl4/ATG6JqJ869rWCdenVGWb9kmdli\n7kUM1rAuVUrfcxu7QSzxkqyREuZo81yRmxocLY5xQ8I4DzCBJIZ+Gk868Xyd8zKO\nBi5e6PA3WWPbHcxVUddtJCnsKjYi0LdzJGQLA/VBgUBIqhZap4MAAXZ3OdTjHZmr\nDIYlvN7shcHFGs7W0CK1MRVYyYv22+wI30JrLlLOFCMnVxliLK44xjYiYRG19HKU\n8F0pYLWTAgMBAAECggEAAS6PRaHTwBWrHYlxmQ98bSU6+NOXwJN/7OuaBStqoFXi\nQrlqMomR1lAawVHQUtOXdusfMqXpZdlDqbWYINzLc8Cwm8SMLs7eZPfNSGs3LPwO\nyjFKZQS/+W7S1izhd51JIkgux19ZIEDLMmCFOZUGH9eTX4XwETDhHRBgCjWOSZBc\naR2PQQjaYVF2uAgd5eT1NVEYlywXh+reCIgzQNRfNIL2TbWI3UFpVnOF7JZ7fdKd\nDvcRngHrw7Cy8oev/tvAqLAYDoL9ulZC1LXEfdf1rOIFe1uZKdqKvfEUe8u0KD7P\ntlFuG69WH3ByaFhy8HFoAXB/eGTDSjwL6EdiwOsT6QKBgQDH2N0quP9lZhm+VHeh\neXsquzAt6BLr46wg/B4p+wE+pg3uban2iBZr8/EEcN3L9sNPfjkwbINvsQzd/CV9\n+QgmPW5S36MFnWoYiqGt5pN8GYPD1r7QwEPrqXGqIXNMufQITDJj3cabG9NdLlzu\n99ZjkOjQ0piqfqPeDmriNQNRxwKBgQDDW57HJ/wbSsC05VriaocIECkSH4EvqnOP\nxcLwGfFryanrtVUw+NVNosUTKwGNPt+Kqxh/E2TNVcBl0uP8v2Pnblr7hexgfxy1\nrJOu1LE3nI42ldSlJd+khDFX2FBHN2CL2wOvyTf8anJ4nzeSamMPCCoAG9xGylOz\nccOEi9T91QKBgB7RKDnAUVHXjry01cXGr+GFAAb0NIa/kvl7J0Od+zEn9hoAOydT\nEPIQqeffZ7ReFvwZIMSA1zvP94X7reRhFIqhCnQpHEBvZ77lEc15MuD+Jj16ze3u\n2AptFKQBiIAaZLEq3tJbjpa4kb1auuX2vc6Yt+4Lq5MO+EHzwzOirSJdAoGAaPf7\n0qsLbWa3MPvj37C5qX11dAV1lrURrvjmC7kE3ZPYN4yRn+S0SCjjl68OAGT+HDZe\nzTkQerxOyueMFSyJc7r6LBgDsL3cIUn/eHtUVbtLNs0/GxXEm1NkZ/0U9Y8t0zf1\nPSjzai+QHnv+ki+T1mnel3xg2bCxVMQV+ExiP5kCgYBR7gf1F0BXzySXTcvAF/Zz\nzCafX8w59PPOa885TEuHT8bOeF27oRrDgPPmwmbzyJPBpFpABXDA88lqVPFlU8b4\nyP1/L+0QlBDIHZ3Qp9Ajr4H5KCaME2AihkigZ5/ralomboUgACWm8dzDvD9NqcC2\noKbsJD/oAEaeH4fPG9Lt2Q==\n-----END PRIVATE KEY-----\n`;

const payload = {
  iss: "make-da-marketing@damarketing-1b8f0.iam.gserviceaccount.com",
  scope: "https://www.googleapis.com/auth/datastore",
  aud: "https://oauth2.googleapis.com/token",
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000)
};

app.get('/', (req, res) => {
  const token = jwt.sign(payload, privateKey, { algorithm: 'RS256' });
  res.send(token); // מחזיר את ה-JWT ישירות
});

app.listen(port, () => {
  console.log(`JWT Service is running on port ${port}`);
});
