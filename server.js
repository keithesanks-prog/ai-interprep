const { createServer } = require('https');
const { parse } = require('url');
const next = require('next');
const fs = require('fs');
const path = require('path');

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = process.env.PORT || 3000;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// Try to load existing certificates, or generate self-signed ones
let httpsOptions = {};

const keyPath = path.join(__dirname, 'localhost-key.pem');
const certPath = path.join(__dirname, 'localhost.pem');

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  console.log('✅ Using existing SSL certificates');
  httpsOptions = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
} else {
  console.log('⚠️  SSL certificates not found. Generating self-signed certificates...');
  console.log('   This will cause a browser warning that you can accept.');
  
  // Generate self-signed certificate using openssl
  const { execSync } = require('child_process');
  try {
    execSync(
      `openssl req -x509 -newkey rsa:4096 -keyout ${keyPath} -out ${certPath} -days 365 -nodes -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost"`,
      { stdio: 'ignore' }
    );
    httpsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
    console.log('✅ Self-signed certificates generated');
  } catch (error) {
    console.error('❌ Failed to generate certificates. Please install openssl or create certificates manually.');
    console.error('   You can create them with:');
    console.error(`   openssl req -x509 -newkey rsa:4096 -keyout ${keyPath} -out ${certPath} -days 365 -nodes -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost"`);
    process.exit(1);
  }
}

app.prepare().then(() => {
  createServer(httpsOptions, async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('internal server error');
    }
  }).listen(port, hostname, (err) => {
    if (err) throw err;
    console.log(`> Ready on https://${hostname === '0.0.0.0' ? 'localhost' : hostname}:${port}`);
    console.log(`> Also accessible at https://192.168.137.166:${port}`);
  });
});











