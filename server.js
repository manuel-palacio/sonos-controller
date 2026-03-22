const express = require('express');
const app = express();
app.get('/health', (req, res) => res.json({ ok: true }));
if (require.main === module) {
  app.listen(process.env.PORT || 3000,
    () => console.log(`Sonos controller running on http://localhost:${process.env.PORT || 3000}`));
}
module.exports = app;
