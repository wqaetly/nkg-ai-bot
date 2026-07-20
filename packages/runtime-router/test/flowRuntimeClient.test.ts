import { describe, expect, it, vi } from "vitest";
import { FlowRuntimeClient } from "../src/flowRuntimeClient.js";
import { createInProcessBackend } from "../src/inProcessBackend.js";
import { RuntimeRouter } from "../src/runtimeRouter.js";
import { RuntimeRouteError, type RuntimeHttpHandler } from "../src/contracts.js";
import { RuntimeTransportError, type RuntimeBackend } from "../src/contracts.js";

function clientWith(handler: RuntimeHttpHandler): FlowRuntimeClient {
  const router = new RuntimeRouter({
    platform: "android",
    desktopPower: () => { throw new Error("desktop-power should not be created"); },
    portable: () => createInProcessBackend({ createHandler: () => handler }),
  });
  return new FlowRuntimeClient(router);
}

describe("FlowRuntimeClient", () => {
  it("uses the upstream invoke route and preserves options", async () => {
    const client = clientWith(async (request) => {
      expect(new URL(request.url).pathname).toBe("/flows/chat%20flow/invoke");
      expect(await request.json()).toEqual({
        input: { prompt: "hello" },
        flowVersion: "2",
        traceId: "trace-1",
        envOverrides: { secrets: { key: "user-key" } },
      });
      return Response.json({
        runId: "run-1",
        flowId: "chat flow",
        flowVersion: "2",
        status: "succeeded",
        output: "hi",
        error: null,
      });
    });

    const result = await client.invoke("chat flow", { prompt: "hello" }, {
      flowVersion: "2",
      traceId: "trace-1",
      envOverrides: { secrets: { key: "user-key" } },
    });

    expect(result.output).toBe("hi");
  });

  it("parses chunked SSE events", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'id: event-1\nevent: node\ndata: {"eventId":"event-1","runId":"run-1",',
      '"flowId":"chat","flowVersion":"1","seq":1,"timestamp":"now","kind":"stream_delta","payload":{"delta":"你"}}\n\n',
      'data: {"eventId":"event-2","runId":"run-1","flowId":"chat","flowVersion":"1","seq":2,"timestamp":"now","kind":"run_finished","payload":{}}\n\n',
    ];
    const client = clientWith(async () => new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } }));

    const events = [];
    for await (const event of client.stream("chat", { prompt: "hello" })) {
      events.push(event);
    }

    expect(events.map((event) => event.kind)).toEqual([
      "stream_delta",
      "run_finished",
    ]);
  });

  it("reports the run id from SSE headers before consuming the first event", async () => {
    const onRunStarted = vi.fn();
    const encoder = new TextEncoder();
    let releaseFirstFrame: (() => void) | undefined;
    const client = clientWith(async () => new Response(new ReadableStream({
      start(controller) {
        releaseFirstFrame = () => {
          controller.enqueue(encoder.encode(
            'data: {"eventId":"e1","runId":"run-before-first-frame","flowId":"chat","flowVersion":"1","seq":1,"timestamp":"now","kind":"run_finished","payload":{}}\n\n',
          ));
          controller.close();
        };
      },
    }), {
      headers: {
        "content-type": "text/event-stream",
        "x-nkg-run-id": "run-before-first-frame",
      },
    }));
    const iterator = client.stream("chat", {}, {
      onRunStarted,
    })[Symbol.asyncIterator]();

    const pending = iterator.next();
    await vi.waitFor(() => expect(onRunStarted).toHaveBeenCalledWith("run-before-first-frame"));
    releaseFirstFrame?.();
    await expect(pending).resolves.toMatchObject({ value: { kind: "run_finished" } });
  });

  it("stops reading and cancels the response body after a terminal run event", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const client = clientWith(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"eventId":"e1","runId":"run-done","flowId":"chat","flowVersion":"1","seq":1,"timestamp":"now","kind":"run_finished","payload":{}}\n\n',
        ));
      },
      cancel() {
        cancelled = true;
      },
    }), { headers: { "content-type": "text/event-stream" } }));

    const events = [];
    for await (const event of client.stream("chat", {})) events.push(event);

    expect(events.map((event) => event.kind)).toEqual(["run_finished"]);
    expect(cancelled).toBe(true);
  });

  it("rejects an SSE response that ends without a terminal run event", async () => {
    const encoder = new TextEncoder();
    const client = clientWith(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"eventId":"e1","runId":"run-cut","flowId":"chat","flowVersion":"1","seq":1,"timestamp":"now","kind":"stream_delta","payload":{"text":"partial"}}\n\n',
        ));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } }));

    const consume = async () => {
      for await (const _event of client.stream("chat", {})) {
        // Consume until the protocol validator observes the premature EOF.
      }
    };

    await expect(consume()).rejects.toMatchObject({
      name: "RuntimeTransportError",
      phase: "stream",
      requestMayHaveExecuted: true,
    } satisfies Partial<RuntimeTransportError>);
  });

  it("invalidates the desktop backend when an SSE response is interrupted", async () => {
    const encoder = new TextEncoder();
    const desktop: RuntimeBackend = {
      kind: "node-sidecar",
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      request: vi.fn(async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"eventId":"e1","runId":"run-cut","flowId":"chat","flowVersion":"1","seq":1,"timestamp":"now","kind":"stream_delta","payload":{"text":"partial"}}\n\n',
          ));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } })),
    };
    const router = new RuntimeRouter({
      platform: "linux",
      mode: "desktop-power",
      desktopPower: () => desktop,
      portable: () => { throw new Error("portable should not be created"); },
    });
    const client = new FlowRuntimeClient(router);

    const consume = async () => {
      for await (const _event of client.stream("chat", {})) {
        // Consume the partial response.
      }
    };

    await expect(consume()).rejects.toBeInstanceOf(RuntimeTransportError);
    expect(desktop.stop).toHaveBeenCalledOnce();
    expect(router.snapshot).toMatchObject({ state: "failed", generation: 1 });
  });

  it("maps upstream error envelopes to RuntimeRouteError", async () => {
    const client = clientWith(async () => Response.json({
      error: { code: "runtime.flow_not_found", message: "missing flow" },
    }, { status: 404 }));

    const promise = client.invoke("missing", null);
    await expect(promise).rejects.toMatchObject({
      name: "RuntimeRouteError",
      status: 404,
      code: "runtime.flow_not_found",
    } satisfies Partial<RuntimeRouteError>);
  });

  it("addresses run inspection, event replay, and cancellation consistently", async () => {
    const calls: string[] = [];
    const client = clientWith(async (request) => {
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}${url.search}`);
      if (url.pathname.endsWith("/events")) {
        return Response.json({ events: [] });
      }
      if (url.pathname.endsWith("/cancel")) {
        return Response.json({ cancelled: true }, { status: 202 });
      }
      return Response.json({
        runId: "run/id",
        flowId: "chat",
        flowVersion: "1",
        status: "running",
      });
    });

    await client.getRun("run/id");
    await client.getEvents("run/id", { cursor: "event 1", limit: 20 });
    await client.cancel("run/id");

    expect(calls).toEqual([
      "GET /runs/run%2Fid",
      "GET /runs/run%2Fid/events?cursor=event+1&limit=20",
      "POST /runs/run%2Fid/cancel",
    ]);
  });
});
