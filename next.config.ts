import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Use webpack instead of Turbopack to avoid bundling issues with optional dependencies
  // Note: Next.js 16 defaults to Turbopack, so we'll use --webpack flag in package.json
  webpack: (config, { isServer }) => {
    // Externalize cohere-ai on server-side to prevent bundling issues
    if (isServer) {
      config.externals = config.externals || [];
      // Handle both array and function externals
      if (Array.isArray(config.externals)) {
        config.externals.push('cohere-ai');
      } else {
        const originalExternals = config.externals;
        config.externals = [
          originalExternals,
          'cohere-ai',
        ];
      }
    }
    
    // For client-side, provide fallbacks
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
      };
    }
    
    return config;
  },
  // Exclude cohere-ai and chromadb from server-side bundle (Next.js 16+)
  serverExternalPackages: ['cohere-ai', 'chromadb'],
};

export default nextConfig;
