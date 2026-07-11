import 'dotenv/config';
import { AgentClient, EventType, DeliverableType, EventStream, isInvalidStatus } from '@croo-network/sdk';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import * as http from 'http';

// Monkey-patch EventStream to extend the pong timeout to 10 minutes (600,000 ms)
(EventStream.prototype as any).resetPongTimeout = function(this: any) {
  if (this.pongTimer) {
    clearTimeout(this.pongTimer);
  }
  this.pongTimer = setTimeout(() => {
    if (this.closed) return;
    this.logger.warn('websocket pong timeout (extended to 600s), reconnecting...');
    if (this.ws) {
      this.ws.terminate();
    }
    this.reconnect();
  }, 600000);
};

interface TranslationRequest {
  item_id: string;
  source_format: 'json' | 'xml';
  target_format: 'json' | 'xml';
}

interface InventoryJSON {
  item_id: string;
  name: string;
  stock_quantity: number;
  unit_price: number;
}

interface PricingQuote {
  ItemID: string;
  Name: string;
  Quantity: number;
  UnitPrice: number;
  TotalPrice: number;
}

const translationReceipts = new Map<string, any>();
const processedOrders = new Map<string, string>();

interface AgentStatus {
  id: string;
  name: string;
  serviceId: string;
  status: 'ONLINE' | 'ACTIVE' | 'IDLE' | 'OFFLINE';
  lastActive: string | null;
}

interface ActiveFlow {
  orderId: string;
  stage: 'negotiating' | 'accepted' | 'paid' | 'upstream_negotiating' | 'upstream_paid' | 'translating' | 'delivering' | 'completed' | 'failed';
  timestamp: string;
  sourceFormat: string;
  targetFormat: string;
  itemId: string;
  dryRun: boolean;
}

const activeFlows = new Map<string, ActiveFlow>();
const transactionHistory: any[] = [];

const agentsStatus: Record<string, AgentStatus> = {
  "relay-agent": {
    id: "relay-agent",
    name: "Relay (Translator)",
    serviceId: process.env.CROO_TARGET_SERVICE_ID || "96832bb4-c86b-4069-8349-6fcc17b52317",
    status: "ONLINE",
    lastActive: new Date().toISOString()
  },
  "pricing-agent": {
    id: "pricing-agent",
    name: "Pricing Agent (XML)",
    serviceId: process.env.RELAY_PRICING_SERVICE_ID || "fed019b5-c00b-450b-a9a6-fb3d177af972",
    status: "IDLE",
    lastActive: null
  },
  "inventory-agent": {
    id: "inventory-agent",
    name: "Inventory Agent (JSON)",
    serviceId: process.env.RELAY_INVENTORY_SERVICE_ID || "017b466e-d493-4dd5-9b67-160f6e39c263",
    status: "IDLE",
    lastActive: null
  }
};

function startHttpServer(client: AgentClient) {
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url || '', `http://localhost:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const now = Date.now();
      for (const key of ['pricing-agent', 'inventory-agent']) {
        const agent = agentsStatus[key];
        if (agent.lastActive) {
          const diff = now - new Date(agent.lastActive).getTime();
          if (diff > 120000) {
            agent.status = 'IDLE';
          }
        }
      }
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({
        agents: Object.values(agentsStatus),
        activeFlows: Array.from(activeFlows.values())
      }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/transactions') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify(transactionHistory));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/registry') {
      const registry = getCompatibilityRegistry();
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify(registry));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/translate') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { payload, sourceFormat, targetFormat, prune } = JSON.parse(body);
          if (!payload || !sourceFormat || !targetFormat) {
            res.setHeader('Content-Type', 'application/json');
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing required fields' }));
            return;
          }

          let translated = '';
          if (sourceFormat === 'json' && targetFormat === 'xml') {
            translated = jsonToXml(JSON.parse(payload));
          } else if (sourceFormat === 'xml' && targetFormat === 'json') {
            translated = xmlToJson(payload);
          } else {
            translated = payload;
          }

          let prunedVal = false;
          let finalPayload = translated;
          if (prune) {
            finalPayload = pruneAndFlatten(finalPayload);
            prunedVal = true;
          }

          const inputHash = crypto.createHash('sha256').update(payload).digest('hex');
          const outputHash = crypto.createHash('sha256').update(finalPayload).digest('hex');

          const receipt = {
            input_payload_hash: inputHash,
            output_payload_hash: outputHash,
            source_format: sourceFormat,
            target_format: targetFormat,
            timestamp: new Date().toISOString(),
            mock: true
          };

          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify({
            translated: finalPayload,
            pruned: prunedVal,
            receipt
          }));
        } catch (err: any) {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message || 'Translation failed' }));
        }
      });
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[HTTP Dashboard Server] Running on http://0.0.0.0:${PORT}`);
  });
}

function pruneAndFlatten(payload: string): string {
  try {
    const trimmed = payload.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed);
      const result: Record<string, any> = {};

      const recurse = (obj: any, currentKey?: string) => {
        if (obj === null || obj === undefined) return;
        if (typeof obj !== 'object') {
          if (currentKey) {
            result[currentKey] = obj;
          }
          return;
        }

        if (Array.isArray(obj)) {
          obj.forEach((item, index) => {
            recurse(item, currentKey ? `${currentKey}_${index}` : `${index}`);
          });
          return;
        }

        for (const key of Object.keys(obj)) {
          const newKey = currentKey ? `${currentKey}_${key}` : key;
          if (['comment', 'desc', 'description', 'metadata', 'createdtime', 'updatedtime', 'timestamp'].includes(key.toLowerCase())) {
            continue;
          }
          recurse(obj[key], newKey);
        }
      };

      recurse(parsed);
      return JSON.stringify(result);
    }

    if (trimmed.startsWith('<')) {
      let cleanXml = trimmed.replace(/<!--[\s\S]*?-->/g, '');
      cleanXml = cleanXml.replace(/>\s+</g, '><').trim();
      return cleanXml;
    }

    return trimmed;
  } catch (err) {
    console.warn("Failed to prune/flatten payload:", err);
    return payload;
  }
}

const COMPAT_REGISTRY_PATH = path.join(__dirname, '../compatibility_registry.json');

function getCompatibilityRegistry(): any[] {
  console.log(`[Compatibility Registry] Reading from path: ${COMPAT_REGISTRY_PATH}`);
  if (!fs.existsSync(COMPAT_REGISTRY_PATH)) {
    console.log(`[Compatibility Registry] File does not exist at path.`);
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(COMPAT_REGISTRY_PATH, 'utf-8'));
    console.log(`[Compatibility Registry] Read ${data.length} entries.`);
    return data;
  } catch (err) {
    console.error(`[Compatibility Registry] Error reading file:`, err);
    return [];
  }
}

function saveCompatibilityRegistry(data: any[]) {
  try {
    fs.writeFileSync(COMPAT_REGISTRY_PATH, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`[Compatibility Registry] Save successful to path: ${COMPAT_REGISTRY_PATH}`);
  } catch (err) {
    console.error(`[Compatibility Registry] Error writing compatibility registry file at ${COMPAT_REGISTRY_PATH}:`, err);
  }
}

function addCompatibilityEntry(entry: {
  source_agent_id: string;
  target_agent_id: string;
  source_format: string;
  target_format: string;
  service_id: string;
}) {
  const registry = getCompatibilityRegistry();
  const exists = registry.some(
    (r: any) =>
      r.source_agent_id === entry.source_agent_id &&
      r.target_agent_id === entry.target_agent_id &&
      r.source_format === entry.source_format &&
      r.target_format === entry.target_format &&
      r.service_id === entry.service_id
  );
  if (!exists) {
    registry.push(entry);
    saveCompatibilityRegistry(registry);
  }
}

const TEMPLATE_REGISTRY_PATH = path.join(__dirname, 'templates_registry.json');

function getTemplatesRegistry(): Record<string, { source_format: string; target_format: string }> {
  if (!fs.existsSync(TEMPLATE_REGISTRY_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(TEMPLATE_REGISTRY_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveTemplate(name: string, source_format: string, target_format: string) {
  const registry = getTemplatesRegistry();
  registry[name] = { source_format, target_format };
  fs.writeFileSync(TEMPLATE_REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
}

function autoDetectFormat(payload: string): 'json' | 'xml' | null {
  const trimmed = payload.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return 'json';
  }
  if (trimmed.startsWith('<')) {
    return 'xml';
  }
  return null;
}

function extractPayload(delivery: any): string {
  if (!delivery) return '';

  if (typeof delivery === 'string') {
    return delivery;
  }

  // 1. If deliverableText is present and non-empty, use it.
  if (typeof delivery.deliverableText === 'string' && delivery.deliverableText.trim() !== '') {
    return delivery.deliverableText;
  }

  // 2. If deliverableSchema is present and non-empty, use it.
  if (typeof delivery.deliverableSchema === 'string' && delivery.deliverableSchema.trim() !== '') {
    return delivery.deliverableSchema;
  }

  // 3. Check common payload wrapper fields
  if (delivery.payload) {
    return typeof delivery.payload === 'string'
      ? delivery.payload
      : JSON.stringify(delivery.payload);
  }

  if (delivery.data) {
    return typeof delivery.data === 'string'
      ? delivery.data
      : JSON.stringify(delivery.data);
  }

  // 4. Check if the delivery itself looks like a custom object/payload
  const standardFields = new Set([
    'deliveryId', 'orderId', 'providerAgentId', 'deliverableType', 
    'deliverableSchema', 'deliverableText', 'contentHash', 'status', 
    'submittedAt', 'verifiedAt', 'createdTime', 'updatedTime'
  ]);

  const customFields: Record<string, any> = {};
  let hasCustomFields = false;
  for (const key of Object.keys(delivery)) {
    if (!standardFields.has(key)) {
      customFields[key] = delivery[key];
      hasCustomFields = true;
    }
  }

  if (hasCustomFields) {
    return JSON.stringify(customFields);
  }

  // 5. Ultimate fallback: stringify the entire delivery object
  return JSON.stringify(delivery);
}

async function pollOrderForDelivery(client: AgentClient, orderId: string): Promise<string> {
  const start = Date.now();
  console.log(`Starting HTTP polling for order ${orderId}...`);
  while (Date.now() - start < 120000) {
    try {
      const order = await client.getOrder(orderId);
      console.log(`Polled order ${orderId}: status = ${order.status}`);
      if (order.status === 'delivered' || order.status === 'completed') {
        const delivery = await client.getDelivery(orderId);
        return extractPayload(delivery);
      }
    } catch (err) {
      console.error(`Error polling order ${orderId}:`, err);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('Upstream request timeout (HTTP polling limit reached)');
}

async function pollNegotiationForOrder(client: AgentClient, negotiationId: string): Promise<string> {
  const start = Date.now();
  console.log(`Starting HTTP polling for negotiation ${negotiationId}...`);
  while (Date.now() - start < 120000) {
    try {
      const negotiation = await client.getNegotiation(negotiationId);
      console.log(`Polled negotiation ${negotiationId}: status = ${negotiation.status}`);
      if ((negotiation as any).orderId) {
        return (negotiation as any).orderId;
      }
      if (negotiation.status === 'rejected') {
        throw new Error(`Negotiation was rejected: ${negotiation.rejectReason}`);
      }
    } catch (err) {
      console.error(`Error polling negotiation ${negotiationId}:`, err);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('Upstream negotiation polling timed out (120s limit reached)');
}

async function fetchUpstreamData(
  client: AgentClient,
  itemId: string,
  targetFormat: 'json' | 'xml',
  dryRun?: boolean
): Promise<{ payload: string; upstreamOrderId: string; upstreamServiceId: string }> {
  const serviceId = targetFormat === 'json'
    ? process.env.RELAY_INVENTORY_SERVICE_ID!
    : process.env.RELAY_PRICING_SERVICE_ID!;

  console.log(`Starting fetchUpstreamData for serviceId: ${serviceId}, itemId: ${itemId}`);

  const targetAgentKey = serviceId === process.env.RELAY_PRICING_SERVICE_ID
    ? "pricing-agent"
    : "inventory-agent";
  if (agentsStatus[targetAgentKey]) {
    agentsStatus[targetAgentKey].status = 'ACTIVE';
    agentsStatus[targetAgentKey].lastActive = new Date().toISOString();
  }

  const upstreamClient = new AgentClient(
    {
      baseURL: process.env.CROO_API_URL!,
      wsURL: process.env.CROO_WS_URL!,
      rpcURL: process.env.BASE_RPC_URL,
    },
    process.env.CROO_SDK_KEY || 'croo_sk_b6c6376008b654a95dfb6ec0f3ed1f19'
  );

  console.log('Connecting upstream WebSocket...');
  const upstreamStream = await upstreamClient.connectWebSocket();

  let orderId: string | null = null;
  let useFallbackPolling = false;

  const wsInstance = (upstreamStream as any).ws;
  if (wsInstance) {
    wsInstance.on('close', (code: number, reason: any) => {
      if (code === 1008) {
        console.warn('Upstream WebSocket closed due to duplicate key policy violation. Falling back to HTTP polling.');
      } else {
        console.warn(`Upstream WebSocket closed with code ${code}. Falling back to HTTP polling.`);
      }
      useFallbackPolling = true;
    });
  }

  // Register listener before negotiating to ensure we catch the event if it fires fast
  upstreamStream.on(EventType.OrderCreated, (e: any) => {
    console.log('Upstream WebSocket received OrderCreated:', e);
    if (negotiation && e.negotiation_id === negotiation.negotiationId) {
      orderId = e.order_id;
    }
  });

  const upstreamReq: any = { item_id: itemId };
  if (dryRun) {
    upstreamReq.dry_run = true;
  }
  console.log(`Creating upstream negotiation for serviceId: ${serviceId}...`);
  const negotiation = await upstreamClient.negotiateOrder({
    serviceId,
    requirements: JSON.stringify(upstreamReq),
  });
  console.log(`Upstream negotiation created successfully: ${negotiation.negotiationId}`);

  // Wait loop for 120 seconds overall timeout
  const start = Date.now();
  const timeoutMs = 120000;
  while (Date.now() - start < timeoutMs) {
    if (orderId) {
      break;
    }

    if (useFallbackPolling) {
      try {
        console.log(`HTTP polling negotiation ${negotiation.negotiationId} for order creation...`);
        const neg = await upstreamClient.getNegotiation(negotiation.negotiationId);
        if ((neg as any).orderId) {
          orderId = (neg as any).orderId;
          break;
        }
        if (neg.status === 'rejected') {
          throw new Error(`Negotiation was rejected: ${neg.rejectReason}`);
        }
      } catch (err) {
        console.error('Error polling negotiation:', err);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  upstreamStream.close();

  if (!orderId) {
    throw new Error('Upstream WebSocket TIMED OUT before order creation.');
  }

  // Wait until order status is "created"
  console.log(`Waiting for order ${orderId} status to be 'created'...`);
  const statusStart = Date.now();
  while (Date.now() - statusStart < 60000) {
    try {
      const order = await upstreamClient.getOrder(orderId);
      console.log(`Order ${orderId} status is: ${order.status}`);
      if (order.status === 'created') {
        break;
      }
    } catch (err) {
      console.error(`Error checking order status:`, err);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // Pay order
  if (dryRun) {
    console.log(`[Simulation] Bypassing upstream payOrder for order ${orderId}`);
  } else {
    console.log(`Upstream order created: ${orderId}. Paying order...`);
    try {
      await upstreamClient.payOrder(orderId);
    } catch (err: any) {
      const isStatusError =
        isInvalidStatus(err) ||
        (err && typeof err.message === 'string' && (
          err.message.includes('INVALID_STATUS') ||
          err.message.includes('INVALID_AGENT_STATUS') ||
          /order can only be paid when status is .*created/i.test(err.message)
        )) ||
        (err && typeof err.reason === 'string' && (
          err.reason === 'INVALID_STATUS' ||
          err.reason === 'INVALID_AGENT_STATUS'
        ));

      if (isStatusError) {
        console.warn("Order already transitioning/paid, continuing to delivery polling...");
      } else {
        throw err;
      }
    }
  }

  // Poll order until delivered/completed
  let payload = "";
  try {
    payload = await pollOrderForDelivery(upstreamClient, orderId);
  } catch (pollErr) {
    if (dryRun) {
      console.warn(`[Simulation] Upstream polling failed/timed out. Falling back to local mock payload.`, pollErr);
      if (targetFormat === 'json') {
        payload = `<?xml version="1.0" encoding="UTF-8"?>
<PricingQuote>
  <ItemID>${itemId}</ItemID>
  <Name>Simulated Dry-Run Product</Name>
  <Quantity>150</Quantity>
  <UnitPrice>19.99</UnitPrice>
  <TotalPrice>2998.50</TotalPrice>
</PricingQuote>`;
      } else {
        payload = JSON.stringify({
          item_id: itemId,
          name: "Simulated Dry-Run Product",
          stock_quantity: 150,
          unit_price: 19.99
        });
      }
    } else {
      throw pollErr;
    }
  }

  return {
    payload,
    upstreamOrderId: orderId,
    upstreamServiceId: serviceId,
  };
}

function jsonToXml(json: InventoryJSON): string {
  const quote: PricingQuote = {
    ItemID: json.item_id,
    Name: json.name,
    Quantity: json.stock_quantity,
    UnitPrice: json.unit_price,
    TotalPrice: json.stock_quantity * json.unit_price,
  };

  return `<?xml version="1.0" encoding="UTF-8"?>
<PricingQuote>
  <ItemID>${quote.ItemID}</ItemID>
  <Name>${quote.Name}</Name>
  <Quantity>${quote.Quantity}</Quantity>
  <UnitPrice>${quote.UnitPrice}</UnitPrice>
  <TotalPrice>${quote.TotalPrice}</TotalPrice>
</PricingQuote>`;
}

function xmlToJson(xml: string): string {
  const itemIdMatch = xml.match(/<ItemID>(.*?)<\/ItemID>/);
  const nameMatch = xml.match(/<Name>(.*?)<\/Name>/);
  const quantityMatch = xml.match(/<Quantity>(.*?)<\/Quantity>/);
  const unitPriceMatch = xml.match(/<UnitPrice>(.*?)<\/UnitPrice>/);

  if (!itemIdMatch || !nameMatch || !quantityMatch || !unitPriceMatch) {
    throw new Error('Invalid XML format');
  }

  const result: InventoryJSON = {
    item_id: itemIdMatch[1],
    name: nameMatch[1],
    stock_quantity: parseInt(quantityMatch[1], 10),
    unit_price: parseFloat(unitPriceMatch[1]),
  };

  return JSON.stringify(result);
}

async function translateData(
  client: AgentClient,
  req: TranslationRequest,
  dryRun?: boolean
): Promise<{ translated: string; upstreamOrderId: string; upstreamServiceId: string }> {
  const upstream = await fetchUpstreamData(
    client,
    req.item_id,
    req.target_format,
    dryRun
  );

  let translated = '';
  if (req.source_format === 'json' && req.target_format === 'xml') {
    const jsonData: InventoryJSON = JSON.parse(upstream.payload);
    translated = jsonToXml(jsonData);
  } else if (req.source_format === 'xml' && req.target_format === 'json') {
    translated = xmlToJson(upstream.payload);
  } else {
    translated = upstream.payload;
  }

  return {
    translated,
    upstreamOrderId: upstream.upstreamOrderId,
    upstreamServiceId: upstream.upstreamServiceId,
  };
}

async function main() {
  // Startup Seed Initialization
  if (!fs.existsSync(COMPAT_REGISTRY_PATH)) {
    console.log(`[Compatibility Registry] Initializing seed data since registry file does not exist.`);
    const seedData = [
      {
        source_agent_id: "seed-pricing-agent",
        target_agent_id: "seed-translation-agent",
        source_format: "xml",
        target_format: "json",
        service_id: "fed019b5-c00b-450b-a9a6-fb3d177af972"
      },
      {
        source_agent_id: "seed-translation-agent",
        target_agent_id: "seed-pricing-agent",
        source_format: "json",
        target_format: "xml",
        service_id: "96832bb4-c86b-4069-8349-6fcc17b52317"
      }
    ];
    saveCompatibilityRegistry(seedData);
  }

  const client = new AgentClient(
    {
      baseURL: process.env.CROO_API_URL!,
      wsURL: process.env.CROO_WS_URL!,
      rpcURL: process.env.BASE_RPC_URL,
    },
    process.env.CROO_SDK_KEY!
  );

  interface ExtendedTranslationRequest {
    item_id?: string;
    source_format?: 'json' | 'xml';
    target_format?: 'json' | 'xml';
    template_name?: string;
    service_type?: string;
    format?: string;
    originalRequirementsText?: string;
    idempotency_key?: string;
    dry_run?: boolean;
    simulation_mode?: boolean;
    context_density?: 'compact' | 'verbose';
    prune?: boolean;
  }

  const orderRequirements = new Map<string, ExtendedTranslationRequest>();

  console.log('Relay provider starting...');
  const stream = await client.connectWebSocket();

  stream.on(EventType.NegotiationCreated, async (e: any) => {
    console.log(`New negotiation: ${e.negotiation_id}`);
    console.log('NegotiationCreated Event:', JSON.stringify(e, null, 2));

    try {
      let reqStr = e.requirements || "";
      if (!reqStr) {
        try {
          const neg = await client.getNegotiation(e.negotiation_id!);
          reqStr = neg.requirements || "";
        } catch (err) {
          console.error("Failed to fetch negotiation requirements:", err);
        }
      }

      let parsedReq: ExtendedTranslationRequest = {};
      if (reqStr) {
        try {
          parsedReq = JSON.parse(reqStr);
        } catch {
          console.warn("Failed to parse requirements JSON:", reqStr);
        }
      }
      parsedReq.originalRequirementsText = reqStr;

      // Feature: Translation Templates
      const templates = getTemplatesRegistry();
      if (parsedReq.template_name) {
        const saved = templates[parsedReq.template_name];
        if (saved) {
          console.log(`Loaded template '${parsedReq.template_name}':`, saved);
          parsedReq.source_format = saved.source_format as any;
          parsedReq.target_format = saved.target_format as any;
        } else if (parsedReq.source_format && parsedReq.target_format) {
          console.log(`Saving template '${parsedReq.template_name}':`, {
            source_format: parsedReq.source_format,
            target_format: parsedReq.target_format
          });
          saveTemplate(parsedReq.template_name, parsedReq.source_format, parsedReq.target_format);
        }
      }

      // Feature: Auto-detection
      if (!parsedReq.source_format || !parsedReq.target_format) {
        const detected = autoDetectFormat(reqStr);
        if (detected) {
          console.log(`Auto-detected source_format: ${detected}`);
          parsedReq.source_format = detected;
          parsedReq.target_format = (detected === 'json' ? 'xml' : 'json');
        } else if (parsedReq.item_id) {
          const detectedItem = autoDetectFormat(parsedReq.item_id);
          if (detectedItem) {
            console.log(`Auto-detected source_format from item_id: ${detectedItem}`);
            parsedReq.source_format = detectedItem;
            parsedReq.target_format = (detectedItem === 'json' ? 'xml' : 'json');
          }
        }
      }

      const result = await client.acceptNegotiation(e.negotiation_id!);
      console.log('acceptNegotiation result:', JSON.stringify(result, null, 2));
      console.log(`Order created: ${result.order.orderId}`);

      orderRequirements.set(result.order.orderId, parsedReq);

      activeFlows.set(result.order.orderId, {
        orderId: result.order.orderId,
        stage: 'accepted',
        timestamp: new Date().toISOString(),
        sourceFormat: parsedReq.source_format || 'json',
        targetFormat: parsedReq.target_format || 'xml',
        itemId: parsedReq.item_id || 'inv-1001',
        dryRun: parsedReq.dry_run === true || parsedReq.simulation_mode === true
      });
    } catch (err) {
      console.error('Accept error:', err);
    }
  });

  stream.on(EventType.OrderPaid, async (e: any) => {
    console.log(`Order ${e.order_id} paid, processing translation...`);
    console.log('OrderPaid Event payload e:', JSON.stringify(e, null, 2));

    const flow = activeFlows.get(e.order_id!);
    try {
      const req = orderRequirements.get(e.order_id!);
      if (!req) {
        throw new Error(`No requirements found for order: ${e.order_id}`);
      }

      if (flow) {
        flow.stage = 'paid';
        flow.timestamp = new Date().toISOString();
      }

      // 1. Idempotency Key Tracking Check
      if (req.idempotency_key && processedOrders.has(req.idempotency_key)) {
        console.log(`[Idempotency] Duplicate request detected for key: ${req.idempotency_key}. Returning cached delivery result.`);
        const cachedDeliveryText = processedOrders.get(req.idempotency_key)!;

        // Check if cached result was a simulation/dry-run (which bypassed deliverOrder on-chain)
        try {
          const cachedObj = JSON.parse(cachedDeliveryText);
          if (cachedObj.mode === "simulation") {
            console.log(`[Idempotency] Cached result is a simulation. Bypassing deliverOrder call and logging simulation payload:`, cachedDeliveryText);
          } else {
            await client.deliverOrder(e.order_id!, {
              deliverableType: DeliverableType.Text,
              deliverableText: cachedDeliveryText,
            });
            console.log(`Order ${e.order_id} delivered immediately using cached result.`);
          }
        } catch {
          await client.deliverOrder(e.order_id!, {
            deliverableType: DeliverableType.Text,
            deliverableText: cachedDeliveryText,
          });
          console.log(`Order ${e.order_id} delivered immediately using cached result.`);
        }

        orderRequirements.delete(e.order_id!);
        return;
      }

      const isDryRun = req.dry_run === true || req.simulation_mode === true;

      // Feature: Compatibility Check handler
      if (req.service_type === "compatibility_check") {
        console.log(`Processing compatibility check for format: ${req.format || req.source_format}`);
        const targetFormat = req.format || req.source_format || "json";
        const registry = getCompatibilityRegistry();
        
        const matched = registry.filter(
          (entry: any) =>
            entry.source_format === targetFormat || entry.target_format === targetFormat
        );

        const responsePayload = {
          compatible_agents: matched.map((entry: any) => ({
            agent_id: entry.source_agent_id,
            format: entry.source_format,
            service_id: entry.service_id
          }))
        };

        const payloadStr = JSON.stringify(responsePayload);
        let deliveryText = "";

        if (isDryRun) {
          const estimatedTokenFee = (payloadStr.length * 0.00005).toFixed(6) + " CROO";
          deliveryText = JSON.stringify({
            status: "success",
            mode: "simulation",
            message: "[SIMULATION] Validated translated payload",
            translated_payload: payloadStr,
            estimated_fee: estimatedTokenFee
          }, null, 2);

          console.log(`[Simulation] Bypassing compatibility check deliverOrder. Mock payload:`, deliveryText);
        } else {
          deliveryText = JSON.stringify({
            translated_payload: payloadStr
          }, null, 2);

          await client.deliverOrder(e.order_id!, {
            deliverableType: DeliverableType.Text,
            deliverableText: deliveryText,
          });
          console.log(`Compatibility check order ${e.order_id} delivered!`);
        }

        if (req.idempotency_key) {
          processedOrders.set(req.idempotency_key, deliveryText);
        }

        orderRequirements.delete(e.order_id!);
        return;
      }

      // Normal translation flow
      const source_format = req.source_format || 'json';
      const target_format = req.target_format || 'xml';
      const item_id = req.item_id || 'inv-1001';

      if (flow) {
        flow.stage = 'translating';
        flow.timestamp = new Date().toISOString();
      }

      console.log(`Translating ${source_format} → ${target_format} for item ${item_id} (Simulation: ${isDryRun})`);

      const result = await translateData(client, {
        item_id,
        source_format: source_format as any,
        target_format: target_format as any,
      }, isDryRun);

      // Feature: Context Window Budgeting (Pruning)
      let translatedOutput = result.translated;
      if (req.context_density === "compact" || req.prune === true) {
        console.log(`[Context Budgeting] Pruning and flattening translated payload...`);
        translatedOutput = pruneAndFlatten(translatedOutput);
      }

      // Feature: Translation Proof (Verifiable Receipt)
      const inputStr = req.originalRequirementsText || JSON.stringify(req);
      const outputStr = translatedOutput;

      const inputHash = crypto.createHash('sha256').update(inputStr).digest('hex');
      const outputHash = crypto.createHash('sha256').update(outputStr).digest('hex');

      const receipt = {
        input_payload_hash: inputHash,
        output_payload_hash: outputHash,
        source_format,
        target_format,
        item_id,
        upstream_agent_service_id: result.upstreamServiceId,
        timestamp: new Date().toISOString(),
        incoming_order_id: e.order_id!,
        upstream_order_id: result.upstreamOrderId,
      };

      translationReceipts.set(e.order_id!, receipt);

      let deliveryText = "";

      if (isDryRun) {
        const estimatedTokenFee = (translatedOutput.length * 0.00005).toFixed(6) + " CROO";
        deliveryText = JSON.stringify({
          status: "success",
          mode: "simulation",
          message: "[SIMULATION] Validated translated payload",
          translated_payload: translatedOutput,
          estimated_fee: estimatedTokenFee,
          receipt: receipt
        }, null, 2);

        console.log(`[Simulation] Bypassing normal deliverOrder. Mock payload:`, deliveryText);
      } else {
        if (flow) {
          flow.stage = 'delivering';
          flow.timestamp = new Date().toISOString();
        }

        deliveryText = JSON.stringify({
          translated_payload: translatedOutput,
          receipt: receipt
        }, null, 2);

        await client.deliverOrder(e.order_id!, {
          deliverableType: DeliverableType.Text,
          deliverableText: deliveryText,
        });

        console.log(`Order ${e.order_id} delivered!`);

        // Feature: Compatibility Intel Registry Save
        const requesterAgentId = e.requester_agent_id || "unknown_requester";
        const providerAgentId = e.provider_agent_id || "unknown_provider";
        const serviceId = e.service_id || "unknown_service";

        addCompatibilityEntry({
          source_agent_id: requesterAgentId,
          target_agent_id: providerAgentId,
          source_format,
          target_format,
          service_id: serviceId
        });
      }

      if (flow) {
        flow.stage = 'completed';
        flow.timestamp = new Date().toISOString();
        transactionHistory.push({
          ...flow,
          receipt
        });
        activeFlows.delete(e.order_id!);
      }

      if (req.idempotency_key) {
        processedOrders.set(req.idempotency_key, deliveryText);
      }

      orderRequirements.delete(e.order_id!);
    } catch (err: any) {
      console.error('Translation error:', err);
      if (flow) {
        flow.stage = 'failed';
        flow.timestamp = new Date().toISOString();
        transactionHistory.push({
          ...flow,
          error: err.message || 'Unknown error'
        });
        activeFlows.delete(e.order_id!);
      }
    }
  });

  stream.on(EventType.OrderCompleted, (e: any) => {
    console.log(`Order ${e.order_id} completed!`);
  });

  process.on('SIGINT', () => {
    stream.close();
    process.exit(0);
  });

  startHttpServer(client);
}

main().catch(console.error);
