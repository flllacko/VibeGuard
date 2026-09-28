import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface DemoServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startDemoServer(faulty: boolean): Promise<DemoServer> {
  const orders = new Map<string, { amountCents: number; discountCents: number; totalCents: number }>();
  const usedCoupons = new Set<string>();
  let nextId = 1;
  const server: Server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/checkout") {
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body: unknown = JSON.parse(raw);
        if (!isCheckout(body)) {
          res.writeHead(400).end(JSON.stringify({ error: "invalid input" }));
          return;
        }
        const thresholdCents = faulty ? 14900 : 15000;
        const discountCents = body.amountCents >= thresholdCents && !usedCoupons.has(body.couponCode) ? 2000 : 0;
        if (discountCents) usedCoupons.add(body.couponCode);
        const orderId = String(nextId++);
        const order = {
          amountCents: body.amountCents,
          discountCents,
          totalCents: body.amountCents - discountCents,
        };
        orders.set(orderId, order);
        res.writeHead(201).end(JSON.stringify({ orderId, ...order }));
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: "bad json" }));
      }
      return;
    }
    const match = /^\/orders\/(\d+)$/.exec(url.pathname);
    if (req.method === "GET" && match) {
      const order = orders.get(match[1]!);
      res.writeHead(order ? 200 : 404).end(JSON.stringify(order ?? { error: "not found" }));
      return;
    }
    res.writeHead(404).end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function isCheckout(value: unknown): value is { amountCents: number; couponCode: string } {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return Number.isSafeInteger(row.amountCents) && Number(row.amountCents) >= 0 &&
    typeof row.couponCode === "string" && row.couponCode.length > 0;
}
