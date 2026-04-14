'use strict';

const https = require('https');

// ── Credentials (set these as environment variables) ─────────────────────────
const SHOPIFY_STORE         = process.env.SHOPIFY_STORE         || 'eqjwir-jc.myshopify.com';
const SHOPIFY_CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

// ── CONFIGURE THIS: paste your Make.com webhook URL here ─────────────────────
const MAKE_WEBHOOK_URL = process.argv[2] || 'https://hook.eu1.make.com/REPLACE_WITH_YOUR_WEBHOOK_ID';

// ── Topics to register ────────────────────────────────────────────────────────
const WEBHOOK_TOPICS = [
  'products/create',
  'products/update',
  'products/delete',
];

function httpsRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getShopifyToken() {
  const formBody = new URLSearchParams({
    grant_type    : 'client_credentials',
    client_id     : SHOPIFY_CLIENT_ID,
    client_secret : SHOPIFY_CLIENT_SECRET,
  }).toString();

  const res = await httpsRequest(
    `https://${SHOPIFY_STORE}/admin/oauth/access_token`,
    {
      method  : 'POST',
      headers : {
        'Content-Type'   : 'application/x-www-form-urlencoded',
        'Content-Length' : Buffer.byteLength(formBody),
      },
    },
    formBody
  );

  const data = JSON.parse(res.body);
  if (res.status !== 200 || !data.access_token) {
    throw new Error(`Token request failed — HTTP ${res.status}\n${res.body}`);
  }
  return data.access_token;
}

async function listExistingWebhooks(token) {
  const res = await httpsRequest(
    `https://${SHOPIFY_STORE}/admin/api/2024-01/webhooks.json`,
    { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } }
  );
  if (res.status !== 200) return [];
  return JSON.parse(res.body).webhooks || [];
}

async function registerWebhook(token, topic) {
  const payload = JSON.stringify({
    webhook: {
      topic,
      address: MAKE_WEBHOOK_URL,
      format: 'json',
    },
  });

  const res = await httpsRequest(
    `https://${SHOPIFY_STORE}/admin/api/2024-01/webhooks.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    },
    payload
  );

  return { status: res.status, body: JSON.parse(res.body) };
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Kymra Lighting — Shopify Webhook Setup');
  console.log('═══════════════════════════════════════════════════\n');

  if (MAKE_WEBHOOK_URL.includes('REPLACE_WITH_YOUR_WEBHOOK_ID')) {
    console.log('⚠  No Make.com webhook URL provided.');
    console.log('   Usage: node setup-shopify-webhook.js https://hook.eu1.make.com/YOUR_ID\n');
    console.log('   Once you have your Make.com webhook URL, run:');
    console.log('   node setup-shopify-webhook.js https://hook.eu1.make.com/YOUR_WEBHOOK_ID\n');
    console.log('   Make.com scenario should:');
    console.log('   1. Receive the Shopify product webhook');
    console.log('   2. Run a shell command or HTTP request to trigger sync-sarah-products.js');
    console.log('   3. Or call a hosted endpoint that runs the sync\n');
    process.exit(0);
  }

  const token = await getShopifyToken();
  console.log(`  ✓ Token obtained\n`);

  console.log('Checking existing webhooks...');
  const existing = await listExistingWebhooks(token);
  console.log(`  Found ${existing.length} existing webhook(s)\n`);

  for (const topic of WEBHOOK_TOPICS) {
    // Skip if already registered for this URL + topic
    const alreadyExists = existing.find(w => w.topic === topic && w.address === MAKE_WEBHOOK_URL);
    if (alreadyExists) {
      console.log(`  ✓ Already registered: ${topic} → ID ${alreadyExists.id}`);
      continue;
    }

    const result = await registerWebhook(token, topic);
    if (result.status === 201) {
      console.log(`  ✓ Registered: ${topic} → ID ${result.body.webhook?.id}`);
    } else {
      console.log(`  ✗ Failed: ${topic} — HTTP ${result.status}`);
      console.log(`    ${JSON.stringify(result.body)}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Webhooks pointing to:', MAKE_WEBHOOK_URL);
  console.log('  Topics: products/create, products/update, products/delete');
  console.log('\n  Make.com scenario setup:');
  console.log('  1. Trigger: Custom Webhook (receives Shopify payload)');
  console.log('  2. Action:  HTTP Request → POST your sync endpoint');
  console.log('     OR:      Run sync-sarah-products.js on a server/cron');
  console.log('═══════════════════════════════════════════════════\n');
}

main();
