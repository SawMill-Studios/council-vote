export interface SecurityHeader {
  key: string;
  value: string;
}

const PERMISSIONS = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "accelerometer=()",
  "gyroscope=()",
  "magnetometer=()",
].join(", ");

/** CSP for every response. Document responses may add a script nonce in middleware. */
export function contentSecurityPolicy(options: { nonce?: string; dev?: boolean } = {}): string {
  const dev = options.dev ?? process.env.NODE_ENV === "development";
  const script = ["'self'"];
  if (options.nonce) script.push(`'nonce-${options.nonce}'`, "'strict-dynamic'");
  script.push("'unsafe-inline'");
  if (dev) script.push("'unsafe-eval'");
  return [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function securityHeaders(csp = contentSecurityPolicy()): SecurityHeader[] {
  return [
    { key: "Content-Security-Policy", value: csp },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: PERMISSIONS },
    { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
    { key: "X-Content-Type-Options", value: "nosniff" },
  ];
}

export function applySecurityHeaders(headers: Headers, csp?: string): void {
  for (const header of securityHeaders(csp)) headers.set(header.key, header.value);
}
