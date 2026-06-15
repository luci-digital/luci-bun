import { expect, test } from "bun:test";

test("undefined args don't throw", () => {
  const request = new Request("https://example.com/", {
    body: undefined,
    "credentials": undefined,
    "redirect": undefined,
    "method": undefined,
    "mode": undefined,
  });

  expect(request.method).toBe("GET");
});

test("request can receive undefined signal", async () => {
  const request = new Request("http://example.com/", {
    method: "POST",
    headers: {
      "Content-Type": "text/bun;charset=utf-8",
    },
    body: "bun",
    signal: undefined,
  });
  expect(request.method).toBe("POST");
  // @ts-ignore
  const clone = new Request(request);
  expect(clone.method).toBe("POST");
  expect(clone.headers.get("content-type")).toBe("text/bun;charset=utf-8");
  expect(await request.text()).toBe("bun");
  expect(await clone.text()).toBe("bun");
});

test("request can receive null signal", async () => {
  const request = new Request("http://example.com/", {
    method: "POST",
    headers: {
      "Content-Type": "text/bun;charset=utf-8",
    },
    body: "bun",
    signal: null,
  });
  expect(request.method).toBe("POST");
  // @ts-ignore
  const clone = new Request(request);
  expect(clone.method).toBe("POST");
  expect(clone.headers.get("content-type")).toBe("text/bun;charset=utf-8");
  expect(await request.text()).toBe("bun");
  expect(await clone.text()).toBe("bun");
});

test("clone() does not lock original body when body was accessed before clone", async () => {
  const readableStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("Hello, world!"));
      controller.close();
    },
  });

  const request = new Request("http://example.com", { method: "POST", body: readableStream });

  // Access body before clone (this triggers the bug in the unfixed version)
  const bodyBeforeClone = request.body;
  expect(bodyBeforeClone?.locked).toBe(false);

  const cloned = request.clone();

  // Both should be unlocked after clone
  expect(request.body?.locked).toBe(false);
  expect(cloned.body?.locked).toBe(false);

  // Both should be readable
  const [originalText, clonedText] = await Promise.all([request.text(), cloned.text()]);

  expect(originalText).toBe("Hello, world!");
  expect(clonedText).toBe("Hello, world!");
});

// https://github.com/oven-sh/bun/issues/28928
// `new Request(input, { body: undefined })` must inherit the streaming body
// from `input` by teeing the readable that `check_body_stream_ref` already
// migrated into the JS-side cache. Going through `Value::clone(None)` here
// creates an empty disconnected ByteStream instead, so `.text()` on the copy
// never resolves.
test("new Request(input, init) with a streaming body inherits it when init.body is undefined", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("hello world"));
      controller.close();
    },
  });
  const original = new Request("http://localhost/test", {
    method: "POST",
    body,
    duplex: "half",
  });

  const copy = new Request(original, { body: undefined });
  expect(copy.method).toBe("POST");
  expect(await copy.text()).toBe("hello world");
});
