'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── Credentials (set these as environment variables) ─────────────────────────
const SHOPIFY_STORE         = process.env.SHOPIFY_STORE         || 'eqjwir-jc.myshopify.com';
const SHOPIFY_CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const VAPI_API_KEY          = process.env.VAPI_API_KEY;
const VAPI_ASSISTANT_ID     = process.env.VAPI_ASSISTANT_ID     || 'f67cfb35-5f40-430d-b70f-718940af7a43';
const VAPI_OLD_FILE_ID      = process.env.VAPI_OLD_FILE_ID      || '';
const OUTPUT_FILE           = path.join(__dirname, 'kymra-sarah-knowledge-base-v7.txt');

// Validate required env vars
const REQUIRED = { SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, VAPI_API_KEY };
const missing  = Object.entries(REQUIRED).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`✗ Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpsRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed   = new URL(url);
    const reqOpts  = {
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

// ── Step 1: Get Shopify access token via client_credentials grant ─────────────

async function getShopifyToken() {
  console.log('Step 1 — Getting Shopify access token (client_credentials grant)...');

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

  let data;
  try { data = JSON.parse(res.body); } catch (_) { data = {}; }

  if (res.status !== 200 || !data.access_token) {
    throw new Error(
      `Token request failed — HTTP ${res.status}\n` +
      `Response: ${res.body}\n\n` +
      `Check that the Shopify app has the read_products scope and the credentials are correct.`
    );
  }

  console.log(`  ✓ Token obtained (scope: ${data.scope}, expires_in: ${data.expires_in}s)`);
  return data.access_token;
}

// ── Step 2: Fetch all active products via GraphQL with cursor pagination ───────

const GQL_QUERY = /* graphql */ `
  query GetProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "status:active") {
      edges {
        node {
          title
          handle
          productType
          tags
          priceRangeV2 {
            minVariantPrice {
              amount
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

async function fetchAllProducts(token) {
  console.log('Step 2 — Fetching active products via Shopify GraphQL 2025-01...');
  const endpoint = `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`;
  const allNodes  = [];
  let cursor      = null;
  let page        = 1;

  while (true) {
    const payload = JSON.stringify({
      query     : GQL_QUERY,
      variables : { first: 250, after: cursor },
    });

    const res = await httpsRequest(endpoint, {
      method  : 'POST',
      headers : {
        'X-Shopify-Access-Token' : token,
        'Content-Type'           : 'application/json',
        'Content-Length'         : Buffer.byteLength(payload),
      },
    }, payload);

    if (res.status !== 200) {
      throw new Error(`GraphQL request failed — HTTP ${res.status}\n${res.body}`);
    }

    const json = JSON.parse(res.body);

    if (json.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(json.errors, null, 2)}`);
    }

    const { edges, pageInfo } = json.data.products;
    for (const { node } of edges) allNodes.push(node);
    console.log(`  Page ${page}: fetched ${edges.length} products (total so far: ${allNodes.length})`);

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
    page++;
  }

  console.log(`  ✓ Total active products: ${allNodes.length}`);
  return allNodes;
}

// ── Step 3: Room suitability from tags ────────────────────────────────────────

function getRooms(tags, title, productType) {
  const source = `${Array.isArray(tags) ? tags.join(' ') : tags} ${title} ${productType}`.toLowerCase();
  const rooms  = [];

  if (/bathroom|ip44|ip65|ip-44|ip-65/.test(source)) rooms.push('Bathroom');
  if (/outdoor/.test(source))                          rooms.push('Outdoor');
  if (/bedroom/.test(source))                          rooms.push('Bedroom');
  if (/kitchen/.test(source))                          rooms.push('Kitchen');
  if (/living/.test(source))                           rooms.push('Living Room');
  if (/hallway|hall/.test(source))                     rooms.push('Hallway');
  if (/dining/.test(source))                           rooms.push('Dining Room');
  if (/study/.test(source))                            rooms.push('Study');
  if (/entrance/.test(source))                         rooms.push('Entrance Hall');
  if (/stairwell|staircase|landing/.test(source))      rooms.push('Stairwell');
  if (/porch/.test(source))                            rooms.push('Porch');

  return rooms.length > 0 ? rooms : ['Living Room', 'Bedroom', 'Hallway', 'Kitchen'];
}

// ── Step 4: Category from productType / title / tags ─────────────────────────

function getCategory(productType, title, tags) {
  const source = `${productType} ${title} ${Array.isArray(tags) ? tags.join(' ') : tags}`.toLowerCase();

  if (/pendant|hanging/.test(source))                                         return 'PENDANTS & CEILING LIGHTS';
  if (/ceiling/.test(source) && !/ip65|ip44|ip-65|ip-44/.test(source))       return 'PENDANTS & CEILING LIGHTS';
  if (/ip65|ip44|ip-65|ip-44|bulkhead|outdoor/.test(source))                  return 'BATHROOM & OUTDOOR IP-RATED LIGHTS';
  if (/wall\s*light|wall-light/.test(source))                                 return 'WALL LIGHTS';
  if (/wall/.test(source) && /light/.test(source))                            return 'WALL LIGHTS';
  if (/socket|switch|dimmer|usb|aerial|toggle|plug/.test(source))             return 'SWITCHES & SOCKETS';

  return 'OTHER';
}

// ── Step 5: Build knowledge base file ────────────────────────────────────────

function buildKnowledgeBase(products) {
  console.log('Step 5 — Building knowledge base...');

  const today = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  const categories = {
    'PENDANTS & CEILING LIGHTS'       : [],
    'WALL LIGHTS'                     : [],
    'BATHROOM & OUTDOOR IP-RATED LIGHTS' : [],
    'SWITCHES & SOCKETS'              : [],
    'OTHER'                           : [],
  };

  for (const node of products) {
    const title       = node.title;
    const price       = parseFloat(node.priceRangeV2?.minVariantPrice?.amount || '0').toFixed(2);
    const handle      = node.handle;
    const url         = `https://kymralighting.co.uk/products/${handle}`;
    const tags        = node.tags || [];
    const productType = node.productType || '';
    const rooms       = getRooms(tags, title, productType);
    const category    = getCategory(productType, title, tags);

    categories[category].push({ title, price, rooms, url });
  }

  let content = `KYMRA LIGHTING – PRODUCT KNOWLEDGE BASE v7\n`;
  content    += `Last Updated: ${today}\n`;
  content    += `Total Active Products: ${products.length}\n`;
  content    += `Website: https://kymralighting.co.uk\n`;
  content    += `Auto-generated from live Shopify store\n\n---\n`;

  const ORDER = [
    'PENDANTS & CEILING LIGHTS',
    'WALL LIGHTS',
    'BATHROOM & OUTDOOR IP-RATED LIGHTS',
    'SWITCHES & SOCKETS',
    'OTHER',
  ];

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

// ── Step 6: Upload file to Vapi ───────────────────────────────────────────────

async function uploadToVapi(fileContent) {
  console.log('Step 6 — Uploading to Vapi...');
  const res = await multipartRequest(
    'https://api.vapi.ai/file',
    `Bearer ${VAPI_API_KEY}`,
    'kymra-sarah-knowledge-base-v7.txt',
    fileContent
  );

  if (res.status !== 201) {
    throw new Error(`Vapi upload failed — HTTP ${res.status}\n${res.body}`);
  }

  const data = JSON.parse(res.body);
  console.log(`  ✓ Uploaded — new file ID: ${data.id}`);
  return data.id;
}

// ── Step 7: PATCH assistant — swap file IDs ───────────────────────────────────

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
    `https://api.vapi.ai/assistant/${VAPI_ASSISTANT_ID}`,
    {
      method  : 'PATCH',
      headers : {
        Authorization    : `Bearer ${VAPI_API_KEY}`,
        'Content-Type'   : 'application/json',
        'Content-Length' : Buffer.byteLength(payload),
      },
    },
    payload
  );

  if (res.status !== 200) {
    throw new Error(`Vapi PATCH failed — HTTP ${res.status}\n${res.body}`);
  }

  const data         = JSON.parse(res.body);
  const attachedIds  = data.model?.knowledgeBase?.fileIds || [];
  console.log(`  ✓ PATCH ${res.status} — KB files now: ${JSON.stringify(attachedIds)}`);
  return res.status;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log('═══════════════════════════════════════════════════');
  console.log('  Kymra Lighting — Sarah Product Sync v2');
  console.log('═══════════════════════════════════════════════════\n');

  const token                = await getShopifyToken();
  const products             = await fetchAllProducts(token);
  const { content, breakdown } = buildKnowledgeBase(products);

  fs.writeFileSync(OUTPUT_FILE, content, 'utf8');
  const kb = (Buffer.byteLength(content) / 1024).toFixed(1);
  console.log(`  ✓ Saved: ${OUTPUT_FILE} (${kb} KB)\n`);

  const newFileId    = await uploadToVapi(content);
  const patchStatus  = await patchAssistant(newFileId);
  const elapsed      = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  SYNC COMPLETE');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Total products          : ${products.length}`);
  for (const [cat, n] of Object.entries(breakdown)) {
    console.log(`    ${cat.padEnd(38)} ${n}`);
  }
  console.log(`  New Vapi file ID        : ${newFileId}`);
  console.log(`  Old file ID removed     : ${VAPI_OLD_FILE_ID}`);
  console.log(`  PATCH status            : ${patchStatus}`);
  console.log(`  Time taken              : ${elapsed}s`);
  console.log('═══════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('\n✗', err.message); process.exit(1); });
