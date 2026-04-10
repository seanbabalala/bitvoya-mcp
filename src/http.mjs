function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function compactErrorText(value, maxLength = 240) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trim()}...`;
}

export function createHttpClient(config) {
  const baseUrl = trimTrailingSlash(config.baseUrl);

  return {
    async request(path, options = {}) {
      const method = options.method || "GET";
      const url = path.startsWith("http")
        ? path
        : `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

      const headers = {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": config.userAgent,
        ...options.headers,
      };

      if (config.acceptLanguage && !headers["accept-language"]) {
        headers["accept-language"] = config.acceptLanguage;
      }

      if (config.authToken && !headers.authorization) {
        headers.authorization = `Bearer ${config.authToken}`;
      }

      let response;

      try {
        response = await fetch(url, {
          method,
          headers,
          body:
            options.body === undefined || options.body === null
              ? undefined
              : JSON.stringify(options.body),
          signal: AbortSignal.timeout(options.timeoutMs || config.timeoutMs),
        });
      } catch (error) {
        throw new Error(
          `Bitvoya API request failed for ${method} ${url}: ${error?.message || String(error)}`
        );
      }

      const text = await response.text();
      let payload = null;

      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
      }

      if (!response.ok) {
        throw new Error(
          `Bitvoya API returned ${response.status} for ${method} ${url}: ${compactErrorText(
            text || response.statusText
          )}`
        );
      }

      if (payload === null) {
        throw new Error(`Bitvoya API returned non-JSON content for ${method} ${url}`);
      }

      return payload;
    },
  };
}
