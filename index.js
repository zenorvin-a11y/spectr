const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send(`
    <html>
      <body style="background:black;color:red;padding:20px;">
        <h1> САНЯСТАИЛ РАБОТАЕТ!</h1>
        <p>7 лет в мад сити не прошли даром</p>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Сервер запущен на порту ' + PORT);
});
