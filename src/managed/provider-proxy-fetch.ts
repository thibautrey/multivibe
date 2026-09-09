import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { Readable } from "node:stream";

export const PROVIDER_EGRESS_PROXY = "http://multivibe-provider-egress-proxy.multivibe-cloud.svc.cluster.local:3128";
const PROVIDER_HOSTS = new Set(["api.mistral.ai", "api.openai.com", "api.anthropic.com",
  "api.deepseek.com", "api.x.ai", "api.z.ai"]);

/** Same CONNECT corridor as managed inference; no direct-network fallback. */
export function createProviderProxyFetch(proxyUrl = PROVIDER_EGRESS_PROXY, ca?: string): typeof fetch {
  const proxy = new URL(proxyUrl);
  if (proxyUrl !== PROVIDER_EGRESS_PROXY && !(proxy.protocol === "http:"
    && proxy.hostname === "127.0.0.1" && proxy.port && proxy.pathname === "/"
    && !proxy.username && !proxy.password && !proxy.search && !proxy.hash)) {
    throw new Error("Invalid provider proxy");
  }
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (input instanceof Request) throw new Error("Provider proxy requires an explicit URL");
    const target = new URL(input);
    if (target.protocol !== "https:" || !PROVIDER_HOSTS.has(target.hostname)
      || target.port || target.username || target.password || target.hash
      || (init?.body != null && typeof init.body !== "string")) {
      throw new Error("Invalid provider destination");
    }
    const signal = init?.signal ?? AbortSignal.timeout(20_000);
    signal.throwIfAborted();
    const agent = new https.Agent({ keepAlive: false });
    agent.createConnection = (_options, callback) => {
      const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
      let settled = false;
      let secure: tls.TLSSocket | undefined;
      let header = Buffer.alloc(0);
      const abort = () => fail(new Error("Provider request aborted"));
      const fail = (error: Error) => {
        if (!settled) { settled = true; callback!(error, undefined as never); }
        socket.destroy();
        secure?.destroy();
      };
      socket.once("close", () => signal.removeEventListener("abort", abort));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return undefined as never; }
      socket.once("error", fail);
      socket.once("end", () => { if (!secure) fail(new Error("Provider tunnel closed")); });
      socket.once("connect", () => socket.write(
        `CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\n\r\n`));
      const readHeader = (chunk: Buffer) => {
        header = Buffer.concat([header, chunk]);
        if (header.length > 4096) { fail(new Error("Invalid provider tunnel response")); return; }
        const end = header.indexOf("\r\n\r\n");
        if (end < 0) return;
        if (header.toString("ascii", 0, end + 4) !== "HTTP/1.1 200 Connection Established\r\n\r\n"
          || header.length !== end + 4) { fail(new Error("Provider tunnel rejected")); return; }
        socket.removeListener("data", readHeader);
        secure = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: true, ...(ca ? { ca } : {}) });
        secure.once("error", fail);
        secure.once("secureConnect", () => {
          if (settled) return;
          settled = true;
          callback!(null, secure!);
        });
      };
      socket.on("data", readHeader);
      return undefined as never;
    };
    return new Promise<Response>((resolve, reject) => {
      const request = https.request(target, { agent, method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers)), signal }, response => {
        response.once("error", reject);
        response.once("close", () => agent.destroy());
        try {
          const status = response.statusCode ?? 502;
          const body = [204, 205, 304].includes(status) ? null
            : Readable.toWeb(response) as ReadableStream<Uint8Array>;
          if (body === null) response.resume();
          resolve(new Response(body, {
            status,
            headers: Object.entries(response.headers).flatMap(([name, value]): [string, string][] =>
              value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]]),
          }));
        } catch (error) { response.destroy(); agent.destroy(); reject(error); }
      });
      request.once("error", error => { agent.destroy(); reject(error); });
      if (typeof init?.body === "string") request.write(init.body);
      request.end();
    });
  }) as typeof fetch;
}
