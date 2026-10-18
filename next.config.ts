import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // CI packs this standalone tree into the release tarball, along with .next,
  // production node_modules and the Prisma engine. The droplet unit still runs `next start`.
  output: "standalone",
  outputFileTracingIncludes: {
    "/**": ["./src/generated/prisma/**/*"],
  },
};

export default nextConfig;
