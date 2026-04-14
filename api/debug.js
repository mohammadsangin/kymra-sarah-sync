module.exports = (req, res) => {
  res.status(200).json({
    SHOPIFY_STORE:         process.env.SHOPIFY_STORE         ? process.env.SHOPIFY_STORE : 'MISSING',
    SHOPIFY_CLIENT_ID:     process.env.SHOPIFY_CLIENT_ID     ? process.env.SHOPIFY_CLIENT_ID.slice(0, 6) + '...' : 'MISSING',
    SHOPIFY_CLIENT_SECRET: process.env.SHOPIFY_CLIENT_SECRET ? process.env.SHOPIFY_CLIENT_SECRET.slice(0, 6) + '...' : 'MISSING',
    VAPI_API_KEY:          process.env.VAPI_API_KEY          ? process.env.VAPI_API_KEY.slice(0, 6) + '...' : 'MISSING',
    VAPI_ASSISTANT_ID:     process.env.VAPI_ASSISTANT_ID     ? process.env.VAPI_ASSISTANT_ID.slice(0, 6) + '...' : 'MISSING',
  });
};
