var express = require('express');
var rateLimit = require('express-rate-limit');
var config = require('../config');
var { AppError } = require('../utils/errors');
var tools = require('../ai/tools');
var actions = require('../ai/actions');
var oauth = require('./oauth');
var { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } = require('@modelcontextprotocol/sdk/server/auth/router.js');
var { requireBearerAuth } = require('@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js');
var { Server } = require('@modelcontextprotocol/sdk/server/index.js');
var { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
var { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

// The Claude connector: Bamboo OS as a remote MCP server, so claude.ai and
// the Claude apps (Settings → Connectors → Add custom connector, URL
// <backend>/mcp) can look things up and get things done in the OS.
//
// It offers the same tools as the AI Assistant screen (src/ai/tools.js), run
// with the signed-in person's own permissions. The person signs in through
// OAuth (./oauth.js); every request then carries a token for that one
// person. Tools that change something run when called — claude.ai asks the
// person to approve each such call first — and are recorded in ai_actions
// with source 'connector'.
//
// Stateless Streamable HTTP: each POST gets a fresh server bound to the
// caller, so nothing is held in memory between requests (and a restart on
// Render loses nothing).

var INSTRUCTIONS =
  'Bamboo OS is the company operating system of Bamboo Products Limited, a bamboo products manufacturer in Ghana. ' +
  "These tools run with the signed-in employee's own permissions: they return only what that person may see, and tools " +
  'for things their role cannot do are not listed. Money is in Ghana cedis (GHS) unless a record says otherwise. ' +
  'Look things up before answering and never invent records. Before a tool that changes something, make sure the ' +
  'person asked for that change; if a name matches several people or products, ask which one.';

function toolListing(t) {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema,
    annotations: {
      readOnlyHint: t.kind === 'read',
      destructiveHint: t.kind === 'action' ? !!t.destructive : undefined,
      idempotentHint: t.kind === 'read' ? true : false,
      openWorldHint: false
    }
  };
}

function text(value, isError) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], isError: isError || undefined };
}

async function callTool(ctx, allowed, name, args) {
  var tool = allowed[name];
  if (!tool) return text('This tool is not available to you.', true);
  try {
    if (tool.kind === 'read') return text(await tool.run(ctx, args || {}));
    var prepared = await tool.prepare(ctx, args || {});
    var done = await actions.runNow(ctx, tool.name, prepared, 'connector');
    return done.status === 'done' ? text(done.result) : text('Not done: ' + done.result, true);
  } catch (err) {
    if (err instanceof AppError) return text(err.message, true);
    console.error('[mcp] tool ' + name + ' failed:', err);
    return text('Something went wrong running this tool.', true);
  }
}

function buildServer(ctx) {
  var available = tools.toolsFor(ctx);
  var allowed = {};
  available.forEach(function (t) { allowed[t.name] = t; });

  var server = new Server(
    { name: 'bamboo-os', title: 'Bamboo OS', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );
  server.setRequestHandler(ListToolsRequestSchema, async function () {
    return { tools: available.map(toolListing) };
  });
  server.setRequestHandler(CallToolRequestSchema, async function (request) {
    return callTool(ctx, allowed, request.params.name, request.params.arguments);
  });
  return server;
}

var mcpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 900,
  standardHeaders: true,
  legacyHeaders: false,
  skip: function () { return config.nodeEnv === 'test'; }
});

function methodNotAllowed(req, res) {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
}

// Everything the connector needs, mounted at the root of the app: the OAuth
// endpoints (/.well-known/…, /authorize, /token, /register, /revoke), the
// sign-in form's POST (/oauth/login) and /mcp itself.
function connectorRouter() {
  var router = express.Router();
  var issuer = new URL(config.publicUrl);
  var resource = new URL(oauth.mcpUrl());

  router.use(mcpAuthRouter({
    provider: oauth.provider,
    issuerUrl: issuer,
    resourceServerUrl: resource,
    resourceName: 'Bamboo OS'
  }));
  router.use(oauth.router);

  var bearer = requireBearerAuth({ verifier: oauth.provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource) });

  router.post('/mcp', mcpLimiter, bearer, async function (req, res) {
    try {
      var ctx = await oauth.buildContextForToken(req.auth);
      if (!ctx) return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Account not found.' }, id: null });
      var server = buildServer(ctx);
      var transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', function () { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] request failed:', err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error.' }, id: null });
    }
  });
  // No server-to-client stream or sessions in stateless mode.
  router.get('/mcp', bearer, methodNotAllowed);
  router.delete('/mcp', bearer, methodNotAllowed);
  return router;
}

module.exports = { connectorRouter: connectorRouter, buildServer: buildServer, INSTRUCTIONS: INSTRUCTIONS };
