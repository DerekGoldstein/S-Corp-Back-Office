import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vault uploads (bank statements, K-1 PDFs) go through server actions.
  experimental: {
    serverActions: { bodySizeLimit: "25mb" },
  },
};

export default nextConfig;
