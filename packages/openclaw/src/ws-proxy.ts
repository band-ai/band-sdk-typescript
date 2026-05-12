import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { URL } from "node:url";

const PATCHED = Symbol.for("thenvoi.openclaw.wsProxyFix");

type RequestCallback = (res: http.IncomingMessage) => void;
type RequestOptions = https.RequestOptions & { headers?: http.OutgoingHttpHeaders };

export function installWsProxyFix(): void {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxyUrl || Reflect.get(globalThis, PATCHED) === true) return;

  let proxy: URL;
  try {
    proxy = new URL(proxyUrl);
  } catch {
    return;
  }

  const proxyHost = proxy.hostname;
  const proxyPort = Number(proxy.port || 3128);
  const requestRef = https.request;

  function createTunnelAgent(targetHost: string, targetPort: number): https.Agent {
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
    Reflect.set(agent, "createConnection", function createConnection(
      options: { servername?: string },
      callback: (error: Error | null, socket?: tls.TLSSocket) => void,
    ): void {
      const connectReq = http.request({
        host: proxyHost,
        port: proxyPort,
        method: "CONNECT",
        path: `${targetHost}:${targetPort}`,
        headers: { Host: `${targetHost}:${targetPort}` },
      });

      connectReq.on("connect", (res, socket, head) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          callback(new Error(`CONNECT ${targetHost}:${targetPort} via proxy failed (${res.statusCode})`));
          return;
        }
        if (head.length > 0) socket.unshift(head);
        callback(null, tls.connect({ socket, servername: options.servername || targetHost }));
      });
      connectReq.on("error", (error) => {
        connectReq.destroy();
        callback(error);
      });
      connectReq.end();
    });
    return agent;
  }

  function callOriginal(
    input: string | URL | RequestOptions,
    options?: RequestCallback | RequestOptions,
    callback?: RequestCallback,
  ): http.ClientRequest {
    if (typeof input === "string" || input instanceof URL) {
      if (typeof options === "function") return requestRef(input, options);
      if (options) return callback ? requestRef(input, options, callback) : requestRef(input, options);
      return callback ? requestRef(input, {}, callback) : requestRef(input);
    }
    if (typeof options === "function") return requestRef(input, options);
    return requestRef(input, callback);
  }

  function patchedRequest(
    input: string | URL | RequestOptions,
    options?: RequestCallback | RequestOptions,
    callback?: RequestCallback,
  ): http.ClientRequest {
    let opts: RequestOptions;
    let cb: RequestCallback | undefined;

    if (typeof input === "string" || input instanceof URL) {
      const url = typeof input === "string" ? new URL(input) : input;
      opts = typeof options === "function" ? {} : options ?? {};
      cb = typeof options === "function" ? options : callback;
      opts = { protocol: url.protocol, hostname: url.hostname, port: url.port, path: url.pathname + url.search, ...opts };
    } else {
      opts = input || {};
      cb = typeof options === "function" ? options : callback;
    }

    const host = opts.hostname || (typeof opts.host === "string" ? opts.host.replace(/:\d+$/, "") : undefined);
    const upgrade = Object.entries(opts.headers ?? {}).some(
      ([key, value]) => key.toLowerCase() === "upgrade" && String(value).toLowerCase() === "websocket",
    );

    if (host && upgrade) {
      const port = Number(opts.port || 443);
      return cb
        ? requestRef({ ...opts, agent: createTunnelAgent(host, port) }, cb)
        : requestRef({ ...opts, agent: createTunnelAgent(host, port) });
    }

    return callOriginal(input, options, callback);
  }

  Reflect.set(https, "request", patchedRequest);
  Reflect.set(globalThis, PATCHED, true);
}
