'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── Credentials (set these as environment variables) ─────────────────────────
// Read at call time inside runSync() so module import never throws
const SHOPIFY_STORE     = () => (process.env.SHOPIFY_STORE || 'eqjwir-jc.myshopify.com').trim();
const SHOPIFY_CLIENT_ID = () => (process.env.SHOPIFY_CLIENT_ID || '').trim();
const SHOPIFY_SECRET    = () => (process.env.SHOPIFY_CLIENT_SECRET || '').trim();
const VAPI_KEY          = () => (process.env.VAPI_API_KEY || '').trim();
const VAPI_ASSISTANT    = () => (process.env.VAPI_ASSISTANT_ID || 'f67cfb35-5f40-430d-b70f-718940af7a43').trim();
const VAPI_OLD_FILE     = () => (process.env.VAPI_OLD_FILE_ID || '').trim();

// Vercel runtime is read-only except /tmp; fall back gracefully
const OUTPUT_FILE = process.env.VERCEL
  ? '/tmp/kymra-sarah-knowledge-base-v7.txt'
  : path.join(__dirname, 'kymra-sarah-knowledge-base-v7.txt');

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpsRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const reqOpts = {
      hostname : parsed.hostname,
      path     : parsed.pathname + parsed.search,
      method   : options.method || 'GET',
      headers  : options.headers || {},
    };
    const req = https.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status  : res.statusCode,
        headers : res.headers,
        body    : Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Multipart upload helper ───────────────────────────────────────────────────

function multipartRequest(url, authHeader, fileName, fileContent) {
  return new Promise((resolve, reject) => {
    const boundary = '----VapiBoundary' + Math.random().toString(16).slice(2);
    const parsed   = new URL(url);
    const CRLF     = '\r\n';
    const partHead = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${fileName}"`,
      'Content-Type: text/plain',
      '',
      '',
    ].join(CRLF);
    const partFoot = `${CRLF}--${boundary}--${CRLF}`;
    const bodyBuf  = Buffer.concat([
      Buffer.from(partHead, 'utf8'),
      Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent, 'utf8'),
      Buffer.from(partFoot, 'utf8'),
    ]);

    const req = https.request({
      hostname : parsed.hostname,
      path     : parsed.pathname,
      method   : 'POST',
      headers  : {
        Authorization    : authHeader,
        'Content-Type'   : `multipart/form-data; boundary=${boundary}`,
        'Content-Length' : bodyBuf.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ── Step 1: Shopify access token ──────────────────────────────────────────────

async function getShopifyToken() {
  console.log('Step 1 — Getting Shopify access token...');
  const formBody = new URLSearchParams({
    grant_type    : 'client_credentials',
    client_id     : SHOPIFY_CLIENT_ID(),
    client_secret : SHOPIFY_SECRET(),
  }).toString();

  const res = await httpsRequest(
    `https://${SHOPIFY_STORE()}/admin/oauth/access_token`,
    {
      method  : 'POST',
      headers : {
        'Content-Type'   : 'application/x-www-form-urlencoded',
        'Content-Length' : Buffer.byteLength(formBody),
      },
    },
    formBody
  );

  let data;
  try { data = JSON.parse(res.body); } catch (_) { data = {}; }

  if (res.status !== 200 || !data.access_token) {
    throw new Error(`Token request failed — HTTP ${res.status}: ${res.body}`);
  }

  console.log(`  ✓ Token obtained (scope: ${data.scope})`);
  return data.access_token;
}

// ── Step 2: Fetch products via GraphQL ───────────────────────────────────────

const GQL_QUERY = `
  query GetProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "status:active") {
      edges {
        node {
          title
          handle
          productType
          tags
          priceRangeV2 {
            minVariantPrice { amount }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function fetchAllProducts(token) {
  console.log('Step 2 — Fetching products via Shopify GraphQL 2025-01...');
  const endpoint = `https://${SHOPIFY_STORE()}/admin/api/2025-01/graphql.json`;
  const allNodes = [];
  let cursor     = null;
  let page       = 1;

  while (true) {
    const payload = JSON.stringify({ query: GQL_QUERY, variables: { first: 250, after: cursor } });
    const res = await httpsRequest(endpoint, {
      method  : 'POST',
      headers : {
        'X-Shopify-Access-Token' : token,
        'Content-Type'           : 'application/json',
        'Content-Length'         : Buffer.byteLength(payload),
      },
    }, payload);

    if (res.status !== 200) throw new Error(`GraphQL failed — HTTP ${res.status}\n${res.body}`);
    const json = JSON.parse(res.body);
    if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);

    const { edges, pageInfo } = json.data.products;
    for (const { node } of edges) allNodes.push(node);
    console.log(`  Page ${page}: ${edges.length} products (total: ${allNodes.length})`);

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
    page++;
  }

  console.log(`  ✓ Total: ${allNodes.length} active products`);
  return allNodes;
}

// ── Step 3: Room mapping ──────────────────────────────────────────────────────

function getRooms(tags, title, productType) {
  const src  = `${Array.isArray(tags) ? tags.join(' ') : tags} ${title} ${productType}`.toLowerCase();
  const rooms = [];
  if (/bathroom|ip44|ip65|ip-44|ip-65/.test(src)) rooms.push('Bathroom');
  if (/outdoor/.test(src))                          rooms.push('Outdoor');
  if (/bedroom/.test(src))                          rooms.push('Bedroom');
  if (/kitchen/.test(src))                          rooms.push('Kitchen');
  if (/living/.test(src))                           rooms.push('Living Room');
  if (/hallway|hall/.test(src))                     rooms.push('Hallway');
  if (/dining/.test(src))                           rooms.push('Dining Room');
  if (/study/.test(src))                            rooms.push('Study');
  if (/entrance/.test(src))                         rooms.push('Entrance Hall');
  if (/stairwell|staircase|landing/.test(src))      rooms.push('Stairwell');
  if (/porch/.test(src))                            rooms.push('Porch');
  return rooms.length > 0 ? rooms : ['Living Room', 'Bedroom', 'Hallway', 'Kitchen'];
}

// ── Step 4: Category mapping ──────────────────────────────────────────────────

function getCategory(productType, title, tags) {
  const src = `${productType} ${title} ${Array.isArray(tags) ? tags.join(' ') : tags}`.toLowerCase();
  if (/pendant|hanging/.test(src))                                   return 'PENDANTS & CEILING LIGHTS';
  if (/ceiling/.test(src) && !/ip65|ip44|ip-65|ip-44/.test(src))    return 'PENDANTS & CEILING LIGHTS';
  if (/ip65|ip44|ip-65|ip-44|bulkhead|outdoor/.test(src))            return 'BATHROOM & OUTDOOR IP-RATED LIGHTS';
  if (/wall\s*light|wall-light/.test(src))                           return 'WALL LIGHTS';
  if (/wall/.test(src) && /light/.test(src))                         return 'WALL LIGHTS';
  if (/socket|switch|dimmer|usb|aerial|toggle|plug/.test(src))       return 'SWITCHES & SOCKETS';
  return 'OTHER';
}

// ── Step 5: Build KB file ─────────────────────────────────────────────────────

function buildKnowledgeBase(products) {
  console.log('Step 5 — Building knowledge base...');
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const categories = {
    'PENDANTS & CEILING LIGHTS'          : [],
    'WALL LIGHTS'                        : [],
    'BATHROOM & OUTDOOR IP-RATED LIGHTS' : [],
    'SWITCHES & SOCKETS'                 : [],
    'OTHER'                              : [],
  };

  for (const node of products) {
    const title       = node.title;
    const price       = parseFloat(node.priceRangeV2?.minVariantPrice?.amount || '0').toFixed(2);
    const handle      = node.handle;
    const url         = `https://kymralighting.co.uk/products/${handle}`;
    const tags        = node.tags || [];
    const productType = node.productType || '';
    categories[getCategory(productType, title, tags)].push({
      title, price, rooms: getRooms(tags, title, productType), url,
    });
  }

  const ORDER = [
    'PENDANTS & CEILING LIGHTS',
    'WALL LIGHTS',
    'BATHROOM & OUTDOOR IP-RATED LIGHTS',
    'SWITCHES & SOCKETS',
    'OTHER',
  ];

  let content = `KYMRA LIGHTING – PRODUCT KNOWLEDGE BASE v7\nLast Updated: ${today}\n`;
  content    += `Total Active Products: ${products.length}\nWebsite: https://kymralighting.co.uk\n`;
  content    += `Auto-generated from live Shopify store\n\n---\n`;

  const breakdown = {};
  for (const cat of ORDER) {
    const items = categories[cat];
    if (!items.length) continue;
    breakdown[cat] = items.length;
    content += `\n${cat}\n`;
    for (const { title, price, rooms, url } of items) {
      content += `- ${title} | £${price} | ${rooms.join(', ')} | ${url}\n`;
    }
  }

  content += `\n---\n\nSARAH'S PRODUCT GUIDELINES:\n`;
  content += `- Always mention the price when discussing any product\n`;
  content += `- Always confirm which rooms the product is suitable for\n`;
  content += `- If a customer describes a room, suggest the most relevant products from that category\n`;
  content += `- Always offer to send a product link via SMS using the send_product_link tool\n`;
  content += `- Use the exact URLs listed above when sending product links\n`;

  return { content, breakdown };
}

// ── Step 6: Upload to Vapi ────────────────────────────────────────────────────

async function uploadToVapi(fileContent) {
  console.log('Step 6 — Uploading to Vapi...');
  const res = await multipartRequest(
    'https://api.vapi.ai/file',
    `Bearer ${VAPI_KEY()}`,
    'kymra-sarah-knowledge-base-v7.txt',
    fileContent
  );
  if (res.status !== 201) throw new Error(`Vapi upload failed — HTTP ${res.status}\n${res.body}`);
  const data = JSON.parse(res.body);
  console.log(`  ✓ Uploaded — new file ID: ${data.id}`);
  return data.id;
}

// ── Step 7: PATCH assistant ───────────────────────────────────────────────────

async function patchAssistant(newFileId) {
  console.log('Step 7 — Patching Sarah assistant...');
  const payload = JSON.stringify({
    model: {
      provider      : 'openai',
      model         : 'gpt-4o-mini',
      knowledgeBase : { fileIds: [newFileId], provider: 'google' },
    },
  });
  const res = await httpsRequest(
    `https://api.vapi.ai/assistant/${VAPI_ASSISTANT()}`,
    {
      method  : 'PATCH',
      headers : {
        Authorization    : `Bearer ${VAPI_KEY()}`,
        'Content-Type'   : 'application/json',
        'Content-Length' : Buffer.byteLength(payload),
      },
    },
    payload
  );
  if (res.status !== 200) throw new Error(`Vapi PATCH failed — HTTP ${res.status}\n${res.body}`);
  const attached = JSON.parse(res.body).model?.knowledgeBase?.fileIds || [];
  console.log(`  ✓ PATCH 200 — KB files: ${JSON.stringify(attached)}`);
  return { status: res.status, newFileId };
}

// ── Exported runSync (used by Vercel api/sync.js) ─────────────────────────────

async function runSync() {
  // Validate env vars at call time, not at import time
  const missing = ['SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'VAPI_API_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);

  const t0                       = Date.now();
  const token                    = await getShopifyToken();
  const products                 = await fetchAllProducts(token);
  const { content, breakdown }   = buildKnowledgeBase(products);

  fs.writeFileSync(OUTPUT_FILE, content, 'utf8');
  console.log(`  ✓ Saved KB (${(Buffer.byteLength(content) / 1024).toFixed(1)} KB)`);

  const newFileId   = await uploadToVapi(content);
  const patchResult = await patchAssistant(newFileId);

  return {
    totalProducts : products.length,
    breakdown,
    newFileId,
    oldFileId     : VAPI_OLD_FILE(),
    patchStatus   : patchResult.status,
    elapsedMs     : Date.now() - t0,
  };
}

module.exports = { runSync };

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  // Validate env vars immediately for CLI usage
  const missing = ['SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'VAPI_API_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`✗ Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════');
  console.log('  Kymra Lighting — Sarah Product Sync v2');
  console.log('═══════════════════════════════════════════════════\n');

  runSync().then(result => {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  SYNC COMPLETE');
    console.log('═══════════════════════════════════════════════════');
    console.log(`  Total products  : ${result.totalProducts}`);
    for (const [cat, n] of Object.entries(result.breakdown)) {
      console.log(`    ${cat.padEnd(38)} ${n}`);
    }
    console.log(`  New file ID     : ${result.newFileId}`);
    console.log(`  Old file ID     : ${result.oldFileId}`);
    console.log(`  PATCH status    : ${result.patchStatus}`);
    console.log(`  Time taken      : ${(result.elapsedMs / 1000).toFixed(1)}s`);
    console.log('═══════════════════════════════════════════════════\n');
  }).catch(err => { console.error('\n✗', err.message); process.exit(1); });
}
