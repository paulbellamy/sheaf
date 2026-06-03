import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // sheaf-server is a workspace package consumed as TypeScript source, so Next
  // must transpile it (its `exports` point at `.ts` files).
  transpilePackages: ["sheaf-server"],
};

export default nextConfig;
