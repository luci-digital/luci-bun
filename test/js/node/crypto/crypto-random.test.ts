import { describe, expect, it } from "bun:test";
import { randomBytes, randomFill, randomFillSync, randomInt } from "crypto";
import { bunEnv, bunExe } from "harness";

describe("randomInt args validation", () => {
  it("default min is 0 so max should be greater than 0", () => {
    expect(() => randomInt(-1)).toThrow(RangeError);
    expect(() => randomInt(0)).toThrow(RangeError);
  });
  it("max should be >= min", () => {
    expect(() => randomInt(1, 0)).toThrow(RangeError);
    expect(() => randomInt(10, 5)).toThrow(RangeError);
  });

  it("we allow negative numbers", () => {
    expect(() => randomInt(-2, -1)).not.toThrow(RangeError);
  });

  it("max/min should not be greater than Number.MAX_SAFE_INTEGER or less than Number.MIN_SAFE_INTEGER", () => {
    expect(() => randomInt(Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError);
    expect(() => randomInt(-Number.MAX_SAFE_INTEGER - 1, -Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError);
  });

  it("max - min should be <= 281474976710655", () => {
    expect(() => randomInt(-2, Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
    expect(() => randomInt(-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  });

  it("accept large negative numbers", () => {
    expect(() => randomInt(-Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER + 1)).not.toThrow(RangeError);
  });

  it("should return undefined if called with callback", async () => {
    const { resolve, promise } = Promise.withResolvers();

    expect(
      randomInt(1, 2, (err, num) => {
        expect(err).toBeUndefined();
        expect(num).toBe(1);
        resolve();
      }),
    ).toBeUndefined();

    await promise;
  });
});

describe("randomBytes", () => {
  it("error should be null", async () => {
    const { resolve, promise } = Promise.withResolvers();

    randomBytes(10, (err, buf) => {
      expect(err).toBeNull();
      expect(buf).toBeInstanceOf(Buffer);
      resolve();
    });

    await promise;
  });
});

describe("randomFill bounds checking", () => {
  // f32 can only represent integers exactly up to 2**24 (16777216). Previously the
  // bounds check in assertSize cast the u32 offset to f32 before adding, so an offset
  // of 16777217 rounded down to 16777216 and `size + offset > length` passed when the
  // true sum exceeded the buffer length, leading to a heap write past the end.
  //
  // Without the fix this path writes out of bounds: debug panics on the slice bounds
  // check and release writes past the allocation. Run in a subprocess so the test
  // runner survives and records a clean failure either way.
  it("randomFillSync rejects size + offset > length when offset exceeds 2**24", async () => {
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `const { randomFillSync } = require("crypto");
         const length = 2 ** 24 + 2; // 16777218
         const offset = 2 ** 24 + 1; // 16777217 -> rounds to 16777216 as f32
         const size = 2;             // offset + size = 16777219 > 16777218
         try {
           randomFillSync(new ArrayBuffer(length), offset, size);
           console.log("NO_THROW");
         } catch (e) {
           console.log(e.code);
         }`,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([proc.stdout.text(), proc.exited]);
    expect(stdout.trim()).toBe("ERR_OUT_OF_RANGE");
    expect(exitCode).toBe(0);
  });

  it("randomFillSync still accepts size + offset == length at the f32 precision boundary", () => {
    const length = 2 ** 24 + 2;
    const offset = 2 ** 24 + 1;
    const size = 1; // offset + size = 16777218 == length, should be fine
    const buf = new Uint8Array(length);
    expect(() => randomFillSync(buf, offset, size)).not.toThrow();
  });

  it("randomFill (async) rejects size + offset > length when offset exceeds 2**24", async () => {
    // Validation errors are thrown synchronously even for the async API. Without the
    // fix the check passes and the threadpool writes past the end of the buffer, so
    // run in a subprocess.
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `const { randomFill } = require("crypto");
         try {
           randomFill(new ArrayBuffer(2 ** 24 + 2), 2 ** 24 + 1, 2, () => {});
           console.log("NO_THROW");
         } catch (e) {
           console.log(e.code);
         }`,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout] = await Promise.all([proc.stdout.text(), proc.exited]);
    expect(stdout.trim()).toBe("ERR_OUT_OF_RANGE");
  });

  it("randomFill (async) still accepts size + offset == length at the f32 precision boundary", async () => {
    const length = 2 ** 24 + 2;
    const offset = 2 ** 24 + 1;
    const size = 1;
    const buf = new Uint8Array(length);
    const { promise, resolve } = Promise.withResolvers<Error | null>();
    randomFill(buf, offset, size, err => resolve(err));
    expect(await promise).toBeNull();
  });
});

describe("randomFill default size with multi-byte typed arrays", () => {
  // In the 3-arg form `randomFill(buf, offset, cb)`, the default size was computed
  // as `buf.len - offset` where `buf.len` is the element count but `offset` had
  // already been scaled to a byte offset by assertOffset. For element_size > 1 this
  // either underflowed (panic in debug) or under-filled the buffer.
  it("randomFill(Float64Array, offset, cb) does not underflow when byte offset > element count", async () => {
    // Without the fix this underflows usize and panics in debug, so run in a subprocess.
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `const { randomFill } = require("crypto");
         // 80 bytes, 10 elements; offset 2 elements = 16 bytes.
         // Previously computed default size as 10 - 16 -> usize underflow.
         randomFill(new Float64Array(10), 2, (err, buf) => {
           if (err) return console.log("ERR:" + err.code);
           console.log("OK", buf[0], buf[1]);
         });`,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([proc.stdout.text(), proc.exited]);
    expect(stdout.trim()).toBe("OK 0 0");
    expect(exitCode).toBe(0);
  });

  it("randomFill passes the buffer (not 0) to the callback when size is 0", async () => {
    const buf = new Uint8Array(0);
    const { promise, resolve } = Promise.withResolvers<[Error | null, unknown]>();
    randomFill(buf, (err, b) => resolve([err, b]));
    const [err, b] = await promise;
    expect(err).toBeNull();
    expect(b).toBe(buf);
  });

  it("randomFill(Float64Array, offset, cb) fills to the end of the buffer", async () => {
    // Run several times since each byte has a 1/256 chance of being 0 anyway.
    let tailFilled = false;
    for (let i = 0; i < 8 && !tailFilled; i++) {
      const buf = new Float64Array(100); // 800 bytes
      const { promise, resolve } = Promise.withResolvers<Error | null>();
      randomFill(buf, 1, err => resolve(err));
      expect(await promise).toBeNull();
      // Previously only bytes 8..744 were filled; bytes 744..800 stayed zero.
      const bytes = new Uint8Array(buf.buffer);
      if (bytes.subarray(744, 800).some(b => b !== 0)) tailFilled = true;
    }
    expect(tailFilled).toBe(true);
  });
});

describe("randomFill with resizable ArrayBuffer", () => {
  // The async path fills a private scratch buffer on the WorkPool thread and
  // copies it back on the JS thread after re-fetching the ArrayBuffer view.
  // Previously the copy-back was all-or-nothing: if the buffer had been shrunk
  // below `offset + size` between scheduling and completion, the bounds check
  // failed and the scratch was silently dropped, so the callback fired with
  // err=null and an untouched (all-zero) buffer. Node copies whatever prefix
  // still fits; match that.

  // With N bytes surviving, the chance all of them are independently zero is
  // 2^-8N; loop a few times so the remaining flake probability is negligible.
  async function expectFilled(
    make: () => { view: ArrayBufferView; check: () => Uint8Array; shrink: () => void },
    offset?: number,
  ) {
    let filled = false;
    for (let i = 0; i < 8 && !filled; i++) {
      const { view, check, shrink } = make();
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      const cb = (err: Error | null, out: unknown) => (err ? reject(err) : resolve(out));
      if (offset === undefined) randomFill(view, cb);
      else randomFill(view, offset, cb);
      shrink();
      expect(await promise).toBe(view);
      if (check().some(b => b !== 0)) filled = true;
    }
    expect(filled).toBe(true);
  }

  it("fills the surviving bytes when the backing ArrayBuffer shrinks before the callback", async () => {
    await expectFilled(() => {
      const ab = new ArrayBuffer(64, { maxByteLength: 128 });
      const view = new Uint8Array(ab);
      return { view, check: () => new Uint8Array(ab), shrink: () => ab.resize(8) };
    });
  });

  it("fills the surviving bytes after the offset when the buffer shrinks into [offset, offset+size)", async () => {
    await expectFilled(() => {
      const ab = new ArrayBuffer(64, { maxByteLength: 128 });
      const view = new Uint8Array(ab);
      // offset 32, requested 32 bytes; shrink to 48 leaves 16 bytes after the offset.
      return {
        view,
        check: () => new Uint8Array(ab).subarray(32),
        shrink: () => ab.resize(48),
      };
    }, 32);
  });

  it("fills the surviving bytes of a length-tracking view when its backing buffer shrinks", async () => {
    await expectFilled(() => {
      const ab = new ArrayBuffer(64, { maxByteLength: 128 });
      const view = new Uint8Array(ab, 16); // length-tracking, starts at byte 16
      return { view, check: () => new Uint8Array(ab).subarray(16), shrink: () => ab.resize(24) };
    });
  });

  it("does not touch bytes before the offset when the buffer shrinks", async () => {
    const ab = new ArrayBuffer(64, { maxByteLength: 128 });
    const view = new Uint8Array(ab);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    randomFill(view, 32, err => (err ? reject(err) : resolve()));
    ab.resize(48);
    await promise;
    expect(Array.from(new Uint8Array(ab).subarray(0, 32))).toEqual(new Array(32).fill(0));
  });

  it("succeeds with no write when the buffer shrinks below the offset", async () => {
    const ab = new ArrayBuffer(64, { maxByteLength: 128 });
    const view = new Uint8Array(ab);
    const { promise, resolve } = Promise.withResolvers<[Error | null, unknown]>();
    randomFill(view, 32, (err, b) => resolve([err, b]));
    ab.resize(16);
    const [err, b] = await promise;
    expect(err).toBeNull();
    expect(b).toBe(view);
    expect(Array.from(new Uint8Array(ab))).toEqual(new Array(16).fill(0));
  });

  it("still fills exactly the requested range when the buffer grows before the callback", async () => {
    let filled = false;
    let tailClean = true;
    for (let i = 0; i < 8 && !filled; i++) {
      const ab = new ArrayBuffer(64, { maxByteLength: 128 });
      const view = new Uint8Array(ab);
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      randomFill(view, err => (err ? reject(err) : resolve()));
      ab.resize(128);
      await promise;
      const bytes = new Uint8Array(ab);
      if (bytes.subarray(0, 64).some(b => b !== 0)) filled = true;
      if (bytes.subarray(64).some(b => b !== 0)) tailClean = false;
    }
    expect({ filled, tailClean }).toEqual({ filled: true, tailClean: true });
  });
});
