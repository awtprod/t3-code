import * as NodeNet from "node:net";

/**
 * Address classes the egress proxy can be told to deny. Each maps to one of the
 * `--deny-*` flags ContainerSandboxBackend passes at container start.
 */
export type DenyClass = "loopback" | "private" | "link-local" | "metadata";

export type IpPolicy = ReadonlySet<DenyClass>;

/** Cloud metadata endpoints, as IPv4 dotted-quad and expanded IPv6 groups. */
const METADATA_V4 = new Set(["169.254.169.254"]);
const METADATA_V6 = [[0xfd_00, 0x0e_c2, 0, 0, 0, 0, 0, 0x02_54]];

const v4Octets = (address: string) => {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets;
};

/** Expands an IPv6 literal, including a trailing dotted-quad, to eight groups. */
const v6Groups = (input: string) => {
  const stripped = input.split("%")[0] ?? "";
  const dot = stripped.lastIndexOf(".");
  let value = stripped;
  if (dot >= 0) {
    const colon = stripped.lastIndexOf(":");
    if (colon < 0) return null;
    const octets = v4Octets(stripped.slice(colon + 1));
    if (octets === null) return null;
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    value = `${stripped.slice(0, colon + 1)}${high}:${low}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const split = (part: string) => (part === "" ? [] : part.split(":"));
  const head = split(halves[0] ?? "");
  const tail = halves.length === 2 ? split(halves[1] ?? "") : [];
  const groups =
    halves.length === 1
      ? head
      : [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => "0"), ...tail];
  if (groups.length !== 8) return null;
  const parsed = groups.map((group) =>
    /^[\da-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN,
  );
  return parsed.some((group) => !Number.isInteger(group)) ? null : parsed;
};

/** IPv4-mapped (::ffff:a.b.c.d) addresses must be judged by their IPv4 value. */
const mappedV4 = (groups: ReadonlyArray<number>) => {
  if (!groups.slice(0, 5).every((group) => group === 0)) return null;
  if (groups[5] !== 0xff_ff) return null;
  const high = groups[6]!;
  const low = groups[7]!;
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
};

const classifyV4 = (octets: ReadonlyArray<number>) => {
  const [a, b] = octets as [number, number, number, number];
  const classes = new Set<DenyClass>();
  if (a === 127 || a === 0) classes.add("loopback");
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))
    classes.add("private");
  if (a === 169 && b === 254) classes.add("link-local");
  if (METADATA_V4.has(octets.join("."))) classes.add("metadata");
  return classes;
};

const classifyV6 = (groups: ReadonlyArray<number>) => {
  const embedded = mappedV4(groups);
  if (embedded !== null) return classifyV4(v4Octets(embedded)!);
  const classes = new Set<DenyClass>();
  const first = groups[0]!;
  if (groups.slice(0, 7).every((group) => group === 0) && (groups[7] === 1 || groups[7] === 0))
    classes.add("loopback");
  if ((first & 0xfe_00) === 0xfc_00) classes.add("private");
  if ((first & 0xff_c0) === 0xfe_80) classes.add("link-local");
  if (METADATA_V6.some((known) => known.every((group, index) => groups[index] === group)))
    classes.add("metadata");
  return classes;
};

/**
 * Returns the deny classes a literal address belongs to, or null when the input
 * is not an IP literal at all. Callers treat null as denied — an address the
 * proxy cannot classify is an address it must not dial.
 */
export const classifyAddress = (address: string): ReadonlySet<DenyClass> | null => {
  const value = address.replace(/^\[|]$/g, "").toLowerCase();
  const family = NodeNet.isIP(value);
  if (family === 4) {
    const octets = v4Octets(value);
    return octets === null ? null : classifyV4(octets);
  }
  if (family !== 6) return null;
  const groups = v6Groups(value);
  return groups === null ? null : classifyV6(groups);
};

export type VetResult = { readonly allowed: true } | { readonly allowed: false; reason: string };

/** Vets a single resolved address against the active policy. */
export const vetAddress = (address: string, policy: IpPolicy): VetResult => {
  const classes = classifyAddress(address);
  if (classes === null) return { allowed: false, reason: "unparseable address" };
  for (const denied of classes)
    if (policy.has(denied)) return { allowed: false, reason: `${denied} address` };
  return { allowed: true };
};

/** Every resolved address must pass; a single protected hit denies the host. */
export const vetAddresses = (addresses: ReadonlyArray<string>, policy: IpPolicy): VetResult => {
  if (addresses.length === 0) return { allowed: false, reason: "host did not resolve" };
  for (const address of addresses) {
    const result = vetAddress(address, policy);
    if (!result.allowed) return result;
  }
  return { allowed: true };
};

const NAME_DENYLIST = new Set(["localhost", "localhost.localdomain", "metadata"]);

/**
 * Names that must never reach the resolver when loopback is denied. This is a
 * convenience guard only; the resolved-address vet is the real control.
 */
export const isDeniedHostname = (hostname: string, policy: IpPolicy) => {
  if (!policy.has("loopback")) return false;
  const value = hostname.toLowerCase().replace(/\.$/, "");
  return NAME_DENYLIST.has(value) || value.endsWith(".localhost");
};
