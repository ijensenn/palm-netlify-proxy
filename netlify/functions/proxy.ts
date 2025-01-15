import { Context } from "@netlify/edge-functions";

const CONFIG = {
  MAX_PROXY_DEPTH: Netlify.environ.get("MAX_PROXY_DEPTH", 5),
  REQUEST_TIMEOUT_MS: Netlify.environ.get("REQUEST_TIMEOUT_MS", 8000),
  ProxyChain: 'x-proxy-chain',
  LoopCount: 'x-loop-count', 
  TargetURL: 'x-target-url',
  HashMap: Netlify.env.get("HashAuth", 'xxx-xxx'),
};

const headersToDelete = [
  CONFIG.HashMap,
  CONFIG.ProxyChain, 
  CONFIG.TargetURL,
  CONFIG.LoopCount,
  'traceparent',
  'x-amzn-trace-id',
  'cdn-loop',
  'cf-connecting-ip',
  'cf-ew-via', 
  'cf-ray',
  'cf-visitor',
  'cf-worker',
  'cf-ipcountry',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-real-ip',
  'forwarded',
  'client-ip',
  'X-Country',
  'X-Language',
  'X-Nf-Account-Id',
  'X-Nf-Account-Tier',
  'X-Nf-Client-Connection-Ip',
  'X-Nf-Deploy-Context',
  'X-Nf-Deploy-Id',
  'X-Nf-Deploy-Published',
  'X-Nf-Geo',
  'X-Nf-Request-Id',
  'X-Nf-Site-Id',
] as const;

const headersToDelete2 = headersToDelete.slice(4);

function parseProxyConfig(request: Request) {
  const encodedProxyChain = request.headers.get(CONFIG.ProxyChain);
  const loopCount = parseInt(request.headers.get(CONFIG.LoopCount) ?? '0');
  let targetUrl = request.headers.get(CONFIG.TargetURL);

  let proxyChain: string[] = encodedProxyChain ? JSON.parse(atob(encodedProxyChain)) : [];
  if (loopCount > CONFIG.MAX_PROXY_DEPTH) {
    throw {
      message: `Proxy depth exceeds maximum limit (${CONFIG.MAX_PROXY_DEPTH})`,
      statusCode: 400
    };
  }

  const proxyHeaders = new Headers(request.headers);
  proxyHeaders.set(CONFIG.LoopCount, (loopCount + 1).toString());

  if (proxyChain.length > 0) {
    targetUrl = proxyChain.shift()!;
    const remainingChain = proxyChain.length > 0 ? btoa(JSON.stringify(proxyChain)) : "e30=";
    proxyHeaders.set(CONFIG.ProxyChain, remainingChain);
    headersToDelete2.forEach(header => proxyHeaders.delete(header));
  } else {
    headersToDelete.forEach(header => proxyHeaders.delete(header));
  }

  proxyHeaders.set("host", new URL(targetUrl!).hostname);
  return {
    targetUrl,
    method: request.method,
    headers: proxyHeaders,
    body: request.body
  };
}

async function proxyRequest(config: {
  targetUrl: string | null,
  method: string,
  headers: Headers,
  body: ReadableStream | null
}): Promise<Response> {
  try {
    if (!config.targetUrl) {
      throw new Error("Target URL is required");
    }

    const finalResponse = await fetch(config.targetUrl, {
      method: config.method,
      headers: config.headers,
      body: config.body,
      signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT_MS)
    });

    return new Response(finalResponse.body, {
      status: finalResponse.status,
      headers: finalResponse.headers
    });
  } catch (error) {
    return new Response(
      error.name === 'AbortError' 
        ? 'Proxy request timed out'
        : error.message || 'Proxy request failed',
      {
        status: error.name === 'AbortError' ? 504 : 502
      }
    );
  }
}

export default async (request: Request, context: Context) => {
  try {
    if (!request.headers.has(CONFIG.HashMap)) {
      return new Response("", { status: 444 });
    }

    const proxyConfig = parseProxyConfig(request);
    return await Promise.race([
      proxyRequest(proxyConfig),
      new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error('Request processing exceeded time limit')), CONFIG.REQUEST_TIMEOUT_MS)
      )
    ]);
  } catch (error) {
    return new Response(error.message || 'Internal Server Error', {
      status: error.statusCode || 500
    });
  }
};
