import 'dotenv/config';
import { AgentClient, EventType, DeliverableType, isInvalidStatus } from '@croo-network/sdk';

async function main() {
  const client = new AgentClient(
    {
      baseURL: process.env.CROO_API_URL!,
      wsURL: process.env.CROO_WS_URL!,
      rpcURL: process.env.BASE_RPC_URL,
    },
    process.env.CROO_SDK_KEY!
  );

  // Connect WebSocket
  const stream = await client.connectWebSocket();

  // Pay when order is created
  stream.on(EventType.OrderCreated, async (e: any) => {
    console.log(`Order ${e.order_id} created, paying...`);

    try {
      const result = await client.payOrder(e.order_id!);
      console.log(`Payment tx: ${result.txHash}`);
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
        console.warn("Order already paid/transitioning, waiting for delivery...");
      } else {
        console.error('pay error:', err);
      }
    }
  });

  // Download deliverable when order is completed
  stream.on(EventType.OrderCompleted, async (e: any) => {
    console.log(`Order ${e.order_id} completed!`);

    try {
      const delivery = await client.getDelivery(e.order_id!);

      switch (delivery.deliverableType) {
        case DeliverableType.Text:
          console.log(`Delivery text: ${delivery.deliverableText}`);
          break;
        case DeliverableType.Schema:
          console.log(`Delivery schema: ${delivery.deliverableSchema}`);
          break;
      }

      stream.close();
      process.exit(0);
    } catch (err) {
      console.error('get delivery error:', err);
    }
  });

  // Start negotiation
  const arg = process.argv[2];
  let requirements = '';

  if (arg === 'compat') {
    requirements = '{"service_type": "compatibility_check", "format": "json"}';
  } else {
    requirements = JSON.stringify({
      item_id: "inv-1001",
      source_format: "json",
      target_format: "xml"
    });
  }

  console.log(`Starting negotiation with arg: ${arg}...`);
  const neg = await client.negotiateOrder({
    serviceId: process.env.CROO_TARGET_SERVICE_ID!,
    requirements,
  });
  console.log(`Negotiation: ${neg.negotiationId}`);

  // Keep process alive
  process.on('SIGINT', () => {
    stream.close();
    process.exit(0);
  });
}

main().catch(console.error);
