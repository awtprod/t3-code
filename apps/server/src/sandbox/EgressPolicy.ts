import { isIP } from "node:net";

export type EgressDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

const forbiddenNames = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
]);

export const evaluateEgressDestination = (
  destination: string,
  crossSandboxHosts: ReadonlySet<string> = new Set(),
): EgressDecision => {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return { allowed: false, reason: "invalid destination" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { allowed: false, reason: "unsupported protocol" };
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (forbiddenNames.has(hostname) || hostname.endsWith(".localhost"))
    return { allowed: false, reason: "loopback destination" };
  if (hostname === "169.254.169.254" || hostname === "100.100.100.200")
    return { allowed: false, reason: "metadata destination" };
  if (crossSandboxHosts.has(hostname))
    return { allowed: false, reason: "cross-sandbox destination" };
  if (isIP(hostname) !== 0 && isForbiddenIp(hostname))
    return { allowed: false, reason: "private, loopback, or link-local destination" };
  return { allowed: true };
};

/** Apply the same policy after DNS resolution so public-looking names cannot
 * bypass the proxy through rebinding to an internal address. */
export const evaluateResolvedEgressDestination = async (
  destination: string,
  resolve: (hostname: string) => Promise<ReadonlyArray<string>>,
  crossSandboxHosts: ReadonlySet<string> = new Set(),
): Promise<EgressDecision> => {
  const initial = evaluateEgressDestination(destination, crossSandboxHosts);
  if (!initial.allowed) return initial;
  const hostname = new URL(destination).hostname.replace(/^\[|\]$/g, "");
  let addresses: ReadonlyArray<string>;
  try {
    addresses = await resolve(hostname);
  } catch {
    return { allowed: false, reason: "destination resolution failed" };
  }
  if (addresses.length === 0) return { allowed: false, reason: "destination did not resolve" };
  if (addresses.some(isForbiddenIp))
    return { allowed: false, reason: "destination resolved to a protected address" };
  return { allowed: true };
};

const isForbiddenIp = (ip: string) => {
  if (ip.includes(":")) {
    const value = ip.toLowerCase();
    return (
      value === "::" ||
      value === "::1" ||
      value.startsWith("fe8") ||
      value.startsWith("fe9") ||
      value.startsWith("fea") ||
      value.startsWith("feb") ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      value.startsWith("::ffff:127.") ||
      value.startsWith("::ffff:10.") ||
      value.startsWith("::ffff:192.168.") ||
      /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(value)
    );
  }
  const octets = ip.split(".").map(Number);
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a! >= 224
  );
};
