// Minimal on purpose. Not yet run: Next.js could not be installed in the development sandbox (no network).
const nextConfig = {
  ...(process.env["CLIPFORGE_CONTAINER_BUILD"] === "true" ? { output: "standalone" as const } : {}),
  ...(process.env["CLIPFORGE_CONTAINER_BUILD"] === "true" ? {
    outputFileTracingExcludes: {
      "/*": ["./node_modules/nodemailer/**"],
    },
  } : {}),
  reactStrictMode: true,
  poweredByHeader: false,
  // These URLs contain one-use credentials in their query strings. Next.js dev request logging
  // prints full URLs, so suppress only these sensitive routes in development logs.
  logging: {
    incomingRequests: {
      ignore: [
        /\/(?:verify-email|reset-password)(?:\?|$)/,
        /\/api\/(?:instagram|auth\/google)\/callback(?:\?|$)/,
        /\/api\/publishing-media\//,
      ],
    },
  },
  // The dev server is opened at 127.0.0.1 as well as localhost. Pages still render if this socket is down.
  allowedDevOrigins: ["127.0.0.1"],
};
export default nextConfig;
