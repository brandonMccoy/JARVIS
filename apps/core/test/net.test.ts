import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { findFreePort, isPortFree } from "../src/net.js";

const HOST = "127.0.0.1";

/** Occupies a port for the duration of `fn`, then releases it. */
async function holding<T>(port: number, fn: () => Promise<T>): Promise<T> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen({ host: HOST, port, exclusive: true }, resolve));
  try {
    return await fn();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A port nothing else in the suite is using. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen({ host: HOST, port: 0 }, resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("isPortFree reports a held port as taken and a free one as free", async () => {
  const port = await freePort();
  assert.equal(await isPortFree(HOST, port), true);
  await holding(port, async () => {
    assert.equal(await isPortFree(HOST, port), false);
  });
  assert.equal(await isPortFree(HOST, port), true, "the port frees up again once released");
});

test("findFreePort returns the start port when it is available", async () => {
  const port = await freePort();
  assert.equal(await findFreePort(HOST, port), port);
});

test("findFreePort walks past a busy port to the next free one", async () => {
  const port = await freePort();
  await holding(port, async () => {
    assert.equal(await findFreePort(HOST, port), port + 1);
  });
});

test("findFreePort walks past a run of busy ports", async () => {
  const port = await freePort();
  await holding(port, async () => {
    await holding(port + 1, async () => {
      await holding(port + 2, async () => {
        assert.equal(await findFreePort(HOST, port), port + 3);
      });
    });
  });
});

test("findFreePort gives up rather than scanning forever", async () => {
  const port = await freePort();
  await holding(port, async () => {
    await assert.rejects(() => findFreePort(HOST, port, 1), /No free port between/);
  });
});
